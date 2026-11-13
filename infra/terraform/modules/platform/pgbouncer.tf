# PgBouncer (F8.1): the api and worker tasks connect to PgBouncer, which multiplexes them onto a
# bounded number of RDS connections in TRANSACTION mode. Safe for this app because every
# per-request setting is transaction-local (DataService: set_config(..., true)) and nothing keeps
# session state between transactions. Migrations hold a session advisory lock, so they run as the
# one-off `migrate` task straight against RDS (DB_MIGRATION_HOST), never through PgBouncer.
#
#   api / worker --6432--> pgbouncer --5432, TLS verify-full (RDS CA bundle)--> RDS
#
# The hop from the app to PgBouncer stays inside the VPC on a security group that admits only the
# api and worker tasks (like ALB -> api, which is HTTP inside the VPC).
#
# Connection budget: pgbouncer_count x pgbouncer_max_db_connections must stay well below the RDS
# max_connections for the instance class (leave room for migrations and operators).

# --- App database login --------------------------------------------------------------------
# Migration 049 creates medexregai_app (NOLOGIN, no BYPASSRLS). After the first migrate run, an
# operator gives it this password once (docs/ops/runbooks.md section 6):
#   ALTER ROLE medexregai_app LOGIN PASSWORD '<app-db secret password>';
resource "random_password" "app_db" {
  length  = 40
  special = false
}

resource "aws_secretsmanager_secret" "app_db" {
  name       = "${local.name}/app-db"
  kms_key_id = aws_kms_key.platform.arn
}

resource "aws_secretsmanager_secret_version" "app_db" {
  secret_id     = aws_secretsmanager_secret.app_db.id
  secret_string = jsonencode({ username = "medexregai_app", password = random_password.app_db.result })
}

# --- Image, logs, network ------------------------------------------------------------------

resource "aws_ecr_repository" "pgbouncer" {
  name                 = "${local.name}/pgbouncer"
  image_tag_mutability = "IMMUTABLE"
  image_scanning_configuration {
    scan_on_push = true
  }
  encryption_configuration {
    encryption_type = "KMS"
    kms_key         = aws_kms_key.platform.arn
  }
}

resource "aws_cloudwatch_log_group" "pgbouncer" {
  name              = "/ecs/${local.name}/pgbouncer"
  retention_in_days = var.log_retention_days
  kms_key_id        = aws_kms_key.platform.arn
}

resource "aws_security_group" "pgbouncer" {
  name        = "${local.name}-pgbouncer"
  description = "PgBouncer: from api and worker tasks; to RDS only"
  vpc_id      = aws_vpc.main.id
}

resource "aws_vpc_security_group_ingress_rule" "pgbouncer_from_tasks" {
  for_each                     = toset(["api", "worker"])
  security_group_id            = aws_security_group.pgbouncer.id
  referenced_security_group_id = aws_security_group.task[each.key].id
  from_port                    = 6432
  to_port                      = 6432
  ip_protocol                  = "tcp"
  description                  = "PgBouncer from ${each.key}"
}

resource "aws_vpc_security_group_egress_rule" "pgbouncer_to_db" {
  security_group_id            = aws_security_group.pgbouncer.id
  referenced_security_group_id = aws_security_group.db.id
  from_port                    = 5432
  to_port                      = 5432
  ip_protocol                  = "tcp"
  description                  = "RDS PostgreSQL"
}

resource "aws_vpc_security_group_ingress_rule" "db_from_pgbouncer" {
  security_group_id            = aws_security_group.db.id
  referenced_security_group_id = aws_security_group.pgbouncer.id
  from_port                    = 5432
  to_port                      = 5432
  ip_protocol                  = "tcp"
  description                  = "PostgreSQL from PgBouncer"
}

resource "aws_service_discovery_service" "pgbouncer" {
  name = "pgbouncer"
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

# --- Task and service ----------------------------------------------------------------------

resource "aws_ecs_task_definition" "pgbouncer" {
  family                   = "${local.name}-pgbouncer"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = var.pgbouncer_cpu
  memory                   = var.pgbouncer_memory
  execution_role_arn       = aws_iam_role.execution.arn
  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = "ARM64"
  }
  container_definitions = jsonencode([{
    name         = "pgbouncer"
    image        = "${aws_ecr_repository.pgbouncer.repository_url}:${var.image_tag}"
    essential    = true
    portMappings = [{ containerPort = 6432, protocol = "tcp" }]
    environment = [
      { name = "DB_HOST", value = aws_db_instance.main.address },
      { name = "DB_PORT", value = tostring(aws_db_instance.main.port) },
      { name = "DB_NAME", value = aws_db_instance.main.db_name },
      { name = "APP_DB_USER", value = "medexregai_app" },
      { name = "SERVER_TLS_SSLMODE", value = "verify-full" },
      { name = "DEFAULT_POOL_SIZE", value = tostring(var.pgbouncer_default_pool_size) },
      { name = "MAX_DB_CONNECTIONS", value = tostring(var.pgbouncer_max_db_connections) },
      { name = "MAX_CLIENT_CONN", value = tostring(var.pgbouncer_max_client_conn) },
    ]
    secrets = [{ name = "APP_DB_PASSWORD", valueFrom = "${aws_secretsmanager_secret.app_db.arn}:password::" }]
    healthCheck = {
      command     = ["CMD-SHELL", "nc -z 127.0.0.1 6432 || exit 1"]
      interval    = 15
      timeout     = 5
      retries     = 3
      startPeriod = 10
    }
    logConfiguration = {
      logDriver = "awslogs"
      options = {
        awslogs-group         = aws_cloudwatch_log_group.pgbouncer.name
        awslogs-region        = var.region
        awslogs-stream-prefix = "pgbouncer"
      }
    }
  }])
}

resource "aws_ecs_service" "pgbouncer" {
  name                   = "pgbouncer"
  cluster                = aws_ecs_cluster.main.id
  task_definition        = aws_ecs_task_definition.pgbouncer.arn
  launch_type            = "FARGATE"
  desired_count          = var.pgbouncer_count
  enable_execute_command = false
  propagate_tags         = "SERVICE"
  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }
  network_configuration {
    subnets          = aws_subnet.private[*].id
    security_groups  = [aws_security_group.pgbouncer.id]
    assign_public_ip = false
  }
  service_registries {
    registry_arn = aws_service_discovery_service.pgbouncer.arn
  }
}

# --- One-off migrations --------------------------------------------------------------------
# CD runs this before rolling out api/worker:
#   aws ecs run-task --cluster <ecs_cluster> --task-definition <migrate_task_definition> \
#     --launch-type FARGATE --network-configuration 'awsvpcConfiguration={subnets=[<private>],securityGroups=[<api sg>]}'
# Owner credentials (RDS master secret) live only in this task, never in the long-running services.
resource "aws_ecs_task_definition" "migrate" {
  family                   = "${local.name}-migrate"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = 256
  memory                   = 512
  execution_role_arn       = aws_iam_role.execution.arn
  task_role_arn            = aws_iam_role.task["api"].arn
  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = "ARM64"
  }
  container_definitions = jsonencode([{
    name      = "migrate"
    image     = "${aws_ecr_repository.svc["api"].repository_url}:${var.image_tag}"
    essential = true
    command   = ["node", "dist/db/migrate.js"]
    environment = concat(local.common_env, [
      { name = "SERVICE_ROLE", value = "migrate" },
      { name = "DB_MIGRATION_HOST", value = aws_db_instance.main.address },
      { name = "DB_MIGRATION_PORT", value = tostring(aws_db_instance.main.port) },
      { name = "DB_MIGRATION_SSL", value = "true" },
    ])
    secrets = concat(local.common_secrets, [
      { name = "DB_MIGRATION_USER", valueFrom = "${local.db_secret}:username::" },
      { name = "DB_MIGRATION_PASSWORD", valueFrom = "${local.db_secret}:password::" },
    ])
    logConfiguration = {
      logDriver = "awslogs"
      options = {
        awslogs-group         = aws_cloudwatch_log_group.svc["api"].name
        awslogs-region        = var.region
        awslogs-stream-prefix = "migrate"
      }
    }
  }])
}
