# fda-data service (ADR-017): the public FDA corpus in its OWN database instance,
# served by its own ECS services. Shares only the VPC, the ECS cluster and the KMS
# key with the main app. Nothing here holds customer data.
#
#   fda-api     /v1 API on 4100, reachable only from the app's api and worker tasks,
#               found at fda-api.<name>.internal (Cloud Map private DNS)
#   fda-worker  openFDA sync and bulk loads; the only writer to fda-postgres
#   fda-pg      RDS PostgreSQL, reachable only from fda-api and fda-worker
#   fda-pg-ro   optional read replica for /v1 reads (var.fda_db_read_replica)

locals {
  fda_services = toset(["fda-api", "fda-worker"])
}

# --- Database -------------------------------------------------------------------------

resource "aws_security_group" "fda_db" {
  name        = "${local.name}-fda-db"
  description = "FDA corpus PostgreSQL from fda-data tasks only"
  vpc_id      = aws_vpc.main.id
}

resource "aws_vpc_security_group_ingress_rule" "fda_db_from_fda_tasks" {
  for_each                     = local.fda_services
  security_group_id            = aws_security_group.fda_db.id
  referenced_security_group_id = aws_security_group.fda_task[each.key].id
  from_port                    = 5432
  to_port                      = 5432
  ip_protocol                  = "tcp"
  description                  = "PostgreSQL from ${each.key}"
}

resource "aws_db_parameter_group" "fda_pg16" {
  name   = "${local.name}-fda-pg16"
  family = "postgres16"
  parameter {
    name  = "rds.force_ssl"
    value = "1"
  }
  parameter {
    name  = "log_min_duration_statement"
    value = "1000"
  }
  # Bulk loads write large batches; give maintenance more memory (kB).
  parameter {
    name         = "maintenance_work_mem"
    value        = "524288"
    apply_method = "pending-reboot"
  }
}

resource "aws_db_instance" "fda" {
  identifier                    = "${local.name}-fda-pg"
  engine                        = "postgres"
  engine_version                = "16"
  instance_class                = var.fda_db_instance_class
  allocated_storage             = var.fda_db_allocated_storage_gb
  max_allocated_storage         = var.fda_db_allocated_storage_gb * 4
  storage_type                  = "gp3"
  storage_encrypted             = true
  kms_key_id                    = aws_kms_key.platform.arn
  db_name                       = "fda_db"
  username                      = "fda_admin"
  manage_master_user_password   = true
  master_user_secret_kms_key_id = aws_kms_key.platform.arn
  db_subnet_group_name          = aws_db_subnet_group.main.name
  vpc_security_group_ids        = [aws_security_group.fda_db.id]
  parameter_group_name          = aws_db_parameter_group.fda_pg16.name
  multi_az                      = false
  # Public data that can be rebuilt from openFDA: shorter retention than customer data.
  backup_retention_period         = var.fda_db_backup_retention_days
  deletion_protection             = var.deletion_protection
  skip_final_snapshot             = !var.deletion_protection
  final_snapshot_identifier       = var.deletion_protection ? "${local.name}-fda-pg-final" : null
  performance_insights_enabled    = true
  performance_insights_kms_key_id = aws_kms_key.platform.arn
  auto_minor_version_upgrade      = true
  copy_tags_to_snapshot           = true
  publicly_accessible             = false
  enabled_cloudwatch_logs_exports = ["postgresql"]
}

resource "aws_db_instance" "fda_replica" {
  count                           = var.fda_db_read_replica ? 1 : 0
  identifier                      = "${local.name}-fda-pg-ro"
  replicate_source_db             = aws_db_instance.fda.identifier
  instance_class                  = var.fda_db_instance_class
  storage_encrypted               = true
  kms_key_id                      = aws_kms_key.platform.arn
  vpc_security_group_ids          = [aws_security_group.fda_db.id]
  parameter_group_name            = aws_db_parameter_group.fda_pg16.name
  performance_insights_enabled    = true
  performance_insights_kms_key_id = aws_kms_key.platform.arn
  auto_minor_version_upgrade      = true
  publicly_accessible             = false
  skip_final_snapshot             = true
}

# --- Network ---------------------------------------------------------------------------

resource "aws_security_group" "fda_task" {
  for_each    = local.fda_services
  name        = "${local.name}-${each.key}"
  description = "${each.key} tasks"
  vpc_id      = aws_vpc.main.id
}

# Egress: the worker reaches openFDA and accessdata.fda.gov through NAT; the API only
# needs its database and AWS endpoints, but shares the same rule for ECR/Secrets pulls.
resource "aws_vpc_security_group_egress_rule" "fda_task_all" {
  for_each          = local.fda_services
  security_group_id = aws_security_group.fda_task[each.key].id
  cidr_ipv4         = "0.0.0.0/0"
  ip_protocol       = "-1"
  description       = "Egress via NAT (openFDA, ECR, Secrets Manager)"
}

# fda-api accepts traffic only from the main app's api and worker tasks.
resource "aws_vpc_security_group_ingress_rule" "fda_api_from_app" {
  for_each                     = toset(["api", "worker"])
  security_group_id            = aws_security_group.fda_task["fda-api"].id
  referenced_security_group_id = aws_security_group.task[each.key].id
  from_port                    = 4100
  to_port                      = 4100
  ip_protocol                  = "tcp"
  description                  = "fda-data /v1 from app ${each.key}"
}

resource "aws_service_discovery_private_dns_namespace" "internal" {
  name = "${local.name}.internal"
  vpc  = aws_vpc.main.id
}

resource "aws_service_discovery_service" "fda_api" {
  name = "fda-api"
  dns_config {
    namespace_id   = aws_service_discovery_private_dns_namespace.internal.id
    routing_policy = "MULTIVALUE"
    dns_records {
      type = "A"
      ttl  = 10
    }
  }
  health_check_custom_config {
    failure_threshold = 1
  }
}

# --- Images, logs, roles -------------------------------------------------------------------

resource "aws_ecr_repository" "fda" {
  name                 = "${local.name}/fda-data"
  image_tag_mutability = "IMMUTABLE"
  image_scanning_configuration {
    scan_on_push = true
  }
  encryption_configuration {
    encryption_type = "KMS"
    kms_key         = aws_kms_key.platform.arn
  }
}

resource "aws_cloudwatch_log_group" "fda" {
  for_each          = local.fda_services
  name              = "/ecs/${local.name}/${each.key}"
  retention_in_days = var.log_retention_days
  kms_key_id        = aws_kms_key.platform.arn
}

resource "aws_secretsmanager_secret" "fda" {
  name       = "${local.name}/fda-data"
  kms_key_id = aws_kms_key.platform.arn
}

# Operator fills OPENFDA_API_KEY (optional, raises openFDA's daily allowance).
resource "aws_secretsmanager_secret_version" "fda" {
  secret_id     = aws_secretsmanager_secret.fda.id
  secret_string = jsonencode({ OPENFDA_API_KEY = "" })
  lifecycle {
    ignore_changes = [secret_string]
  }
}

data "aws_iam_policy_document" "fda_execution_secrets" {
  statement {
    actions   = ["secretsmanager:GetSecretValue"]
    resources = [aws_secretsmanager_secret.fda.arn, aws_db_instance.fda.master_user_secret[0].secret_arn]
  }
  statement {
    actions   = ["kms:Decrypt"]
    resources = [aws_kms_key.platform.arn]
  }
}

# Separate execution role: fda-data tasks can read only their own secrets, never the app's.
resource "aws_iam_role" "fda_execution" {
  name               = "${local.name}-fda-ecs-execution"
  assume_role_policy = data.aws_iam_policy_document.ecs_assume.json
}

resource "aws_iam_role_policy_attachment" "fda_execution_managed" {
  role       = aws_iam_role.fda_execution.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

resource "aws_iam_role_policy" "fda_execution_secrets" {
  name   = "read-fda-secrets"
  role   = aws_iam_role.fda_execution.id
  policy = data.aws_iam_policy_document.fda_execution_secrets.json
}

# Task roles: fda-api has no AWS permissions; fda-worker may read and write the FDA
# document bucket (fda_docs.tf) for 510(k) summary PDFs.
resource "aws_iam_role" "fda_task" {
  for_each           = local.fda_services
  name               = "${local.name}-${each.key}-task"
  assume_role_policy = data.aws_iam_policy_document.ecs_assume.json
}

# --- Task definitions and services ---------------------------------------------------------

locals {
  fda_db_secret = aws_db_instance.fda.master_user_secret[0].secret_arn
  fda_env = [
    { name = "NODE_ENV", value = "production" },
    { name = "FDA_DB_HOST", value = aws_db_instance.fda.address },
    { name = "FDA_DB_PORT", value = tostring(aws_db_instance.fda.port) },
    { name = "FDA_DB_NAME", value = aws_db_instance.fda.db_name },
    { name = "FDA_DB_SSL", value = "true" },
    { name = "FDA_READ_DB_HOST", value = var.fda_db_read_replica ? aws_db_instance.fda_replica[0].address : "" },
    { name = "PORT", value = "4100" },
    { name = "FDA_DOCS_BUCKET", value = aws_s3_bucket.fda_docs.bucket },
    { name = "FDA_DOCS_REGION", value = var.region },
  ]
  fda_secrets = [
    { name = "FDA_DB_USER", valueFrom = "${local.fda_db_secret}:username::" },
    { name = "FDA_DB_PASSWORD", valueFrom = "${local.fda_db_secret}:password::" },
    { name = "OPENFDA_API_KEY", valueFrom = "${aws_secretsmanager_secret.fda.arn}:OPENFDA_API_KEY::" },
  ]
  fda_tasks = {
    # The API applies pending migrations at start (advisory-locked, safe with several tasks).
    "fda-api" = { cpu = 512, memory = 1024, command = ["sh", "-c", "node dist/db/migrate.js && node dist/index.js"], port = true }
    # Bulk loads stream zip files to /tmp and upsert in batches: more memory.
    "fda-worker" = { cpu = 1024, memory = 2048, command = ["node", "dist/worker.js"], port = false }
  }
}

resource "aws_ecs_task_definition" "fda" {
  for_each                 = local.fda_services
  family                   = "${local.name}-${each.key}"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = local.fda_tasks[each.key].cpu
  memory                   = local.fda_tasks[each.key].memory
  execution_role_arn       = aws_iam_role.fda_execution.arn
  task_role_arn            = aws_iam_role.fda_task[each.key].arn
  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = "ARM64"
  }
  container_definitions = jsonencode([{
    name         = each.key
    image        = "${aws_ecr_repository.fda.repository_url}:${var.image_tag}"
    essential    = true
    command      = local.fda_tasks[each.key].command
    portMappings = local.fda_tasks[each.key].port ? [{ containerPort = 4100, protocol = "tcp" }] : []
    environment  = local.fda_env
    secrets      = local.fda_secrets
    healthCheck = local.fda_tasks[each.key].port ? {
      command     = ["CMD-SHELL", "wget -qO- http://localhost:4100/ready || exit 1"]
      interval    = 15
      timeout     = 5
      retries     = 3
      startPeriod = 60
    } : null
    logConfiguration = {
      logDriver = "awslogs"
      options = {
        awslogs-group         = aws_cloudwatch_log_group.fda[each.key].name
        awslogs-region        = var.region
        awslogs-stream-prefix = each.key
      }
    }
  }])
}

resource "aws_ecs_service" "fda" {
  for_each               = local.fda_services
  name                   = each.key
  cluster                = aws_ecs_cluster.main.id
  task_definition        = aws_ecs_task_definition.fda[each.key].arn
  launch_type            = "FARGATE"
  desired_count          = each.key == "fda-api" ? var.fda_api_desired_count : var.fda_worker_count
  enable_execute_command = false
  propagate_tags         = "SERVICE"
  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }
  network_configuration {
    subnets          = aws_subnet.private[*].id
    security_groups  = [aws_security_group.fda_task[each.key].id]
    assign_public_ip = false
  }
  dynamic "service_registries" {
    for_each = each.key == "fda-api" ? [1] : []
    content {
      registry_arn = aws_service_discovery_service.fda_api.arn
    }
  }
  lifecycle {
    ignore_changes = [desired_count]
  }
}

resource "aws_appautoscaling_target" "fda_api" {
  service_namespace  = "ecs"
  resource_id        = "service/${aws_ecs_cluster.main.name}/${aws_ecs_service.fda["fda-api"].name}"
  scalable_dimension = "ecs:service:DesiredCount"
  min_capacity       = var.fda_api_desired_count
  max_capacity       = var.fda_api_max_count
}

resource "aws_appautoscaling_policy" "fda_api_cpu" {
  name               = "${local.name}-fda-api-cpu"
  service_namespace  = "ecs"
  resource_id        = aws_appautoscaling_target.fda_api.resource_id
  scalable_dimension = aws_appautoscaling_target.fda_api.scalable_dimension
  policy_type        = "TargetTrackingScaling"
  target_tracking_scaling_policy_configuration {
    target_value = 60
    predefined_metric_specification {
      predefined_metric_type = "ECSServiceAverageCPUUtilization"
    }
  }
}
