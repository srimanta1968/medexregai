# Containers on a managed service (ADR-001): ECS on Fargate.
#   api      - Express API behind the ALB (private subnets, NAT egress)
#   worker   - Postgres-queue workers (ADR-005): fetch, classify, draft, export
#   docproc  - sandboxed conversion pool (ADR-013): isolated subnets, NO internet

resource "aws_ecr_repository" "svc" {
  for_each             = local.services
  name                 = "${local.name}/${each.key}"
  image_tag_mutability = "IMMUTABLE"
  image_scanning_configuration {
    scan_on_push = true
  }
  encryption_configuration {
    encryption_type = "KMS"
    kms_key         = aws_kms_key.platform.arn
  }
}

resource "aws_ecs_cluster" "main" {
  name = local.name
  setting {
    name  = "containerInsights"
    value = "enabled"
  }
}

resource "aws_cloudwatch_log_group" "svc" {
  for_each          = local.services
  name              = "/ecs/${local.name}/${each.key}"
  retention_in_days = var.log_retention_days
  kms_key_id        = aws_kms_key.platform.arn
}

# --- Secrets the tasks read at start ----------------------------------------------

resource "random_password" "jwt" {
  length  = 64
  special = false
}

resource "random_id" "encryption_key" {
  byte_length = 32
}

resource "aws_secretsmanager_secret" "app" {
  name       = "${local.name}/app"
  kms_key_id = aws_kms_key.platform.arn
}

# JWT and field-encryption keys are generated once; SSO client secrets and the
# Claude API key are added to this secret by an operator (keys left empty here).
resource "aws_secretsmanager_secret_version" "app" {
  secret_id = aws_secretsmanager_secret.app.id
  secret_string = jsonencode({
    JWT_SECRET                  = random_password.jwt.result
    ENCRYPTION_KEY              = random_id.encryption_key.hex
    SSO_GOOGLE_CLIENT_SECRET    = ""
    SSO_MICROSOFT_CLIENT_SECRET = ""
    AI_API_KEY                  = ""
  })
  lifecycle {
    ignore_changes = [secret_string]
  }
}

# --- IAM ---------------------------------------------------------------------------

data "aws_iam_policy_document" "ecs_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ecs-tasks.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "execution" {
  name               = "${local.name}-ecs-execution"
  assume_role_policy = data.aws_iam_policy_document.ecs_assume.json
}

resource "aws_iam_role_policy_attachment" "execution_managed" {
  role       = aws_iam_role.execution.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

data "aws_iam_policy_document" "execution_secrets" {
  statement {
    actions = ["secretsmanager:GetSecretValue"]
    resources = [
      aws_secretsmanager_secret.app.arn,
      aws_secretsmanager_secret.redis_auth.arn,
      aws_db_instance.main.master_user_secret[0].secret_arn,
    ]
  }
  statement {
    actions   = ["kms:Decrypt"]
    resources = [aws_kms_key.platform.arn]
  }
}

resource "aws_iam_role_policy" "execution_secrets" {
  name   = "read-secrets"
  role   = aws_iam_role.execution.id
  policy = data.aws_iam_policy_document.execution_secrets.json
}

resource "aws_iam_role" "task" {
  for_each           = local.services
  name               = "${local.name}-${each.key}-task"
  assume_role_policy = data.aws_iam_policy_document.ecs_assume.json
}

# Every service reads/writes the client bucket. Objects under a tenant prefix are
# encrypted with that tenant's key; the app may only use keys tagged as tenant keys.
data "aws_iam_policy_document" "task_data" {
  statement {
    sid       = "ClientBucket"
    actions   = ["s3:GetObject", "s3:PutObject", "s3:DeleteObject", "s3:AbortMultipartUpload"]
    resources = ["${aws_s3_bucket.client.arn}/*"]
  }
  statement {
    sid       = "ClientBucketList"
    actions   = ["s3:ListBucket"]
    resources = [aws_s3_bucket.client.arn]
  }
  statement {
    sid       = "PlatformKey"
    actions   = ["kms:Encrypt", "kms:Decrypt", "kms:GenerateDataKey", "kms:DescribeKey"]
    resources = [aws_kms_key.platform.arn]
  }
  statement {
    sid       = "TenantKeysUse"
    actions   = ["kms:Encrypt", "kms:Decrypt", "kms:GenerateDataKey", "kms:DescribeKey"]
    resources = ["arn:aws:kms:${var.region}:${local.account_id}:key/*"]
    condition {
      test     = "StringLike"
      variable = "aws:ResourceTag/medexregai:tenant"
      values   = ["*"]
    }
    condition {
      test     = "StringEquals"
      variable = "aws:ResourceTag/medexregai:environment"
      values   = [var.environment]
    }
  }
}

resource "aws_iam_role_policy" "task_data" {
  for_each = local.services
  name     = "client-data"
  role     = aws_iam_role.task[each.key].id
  policy   = data.aws_iam_policy_document.task_data.json
}

# Only the API creates tenant keys (firm onboarding), and only with the tenant tags.
data "aws_iam_policy_document" "api_tenant_keys" {
  statement {
    actions   = ["kms:CreateKey", "kms:TagResource"]
    resources = ["*"]
    condition {
      test     = "StringEquals"
      variable = "aws:RequestTag/medexregai:environment"
      values   = [var.environment]
    }
    condition {
      test     = "ForAllValues:StringEquals"
      variable = "aws:TagKeys"
      values   = ["medexregai:tenant", "medexregai:environment"]
    }
  }
  statement {
    actions   = ["kms:CreateAlias"]
    resources = ["arn:aws:kms:${var.region}:${local.account_id}:alias/${local.name}-tenant-*"]
  }
  statement {
    actions   = ["kms:CreateAlias", "kms:EnableKeyRotation", "kms:ScheduleKeyDeletion"]
    resources = ["arn:aws:kms:${var.region}:${local.account_id}:key/*"]
    condition {
      test     = "StringEquals"
      variable = "aws:ResourceTag/medexregai:environment"
      values   = [var.environment]
    }
  }
}

resource "aws_iam_role_policy" "api_tenant_keys" {
  name   = "tenant-keys"
  role   = aws_iam_role.task["api"].id
  policy = data.aws_iam_policy_document.api_tenant_keys.json
}

# --- Security groups -----------------------------------------------------------------

resource "aws_security_group" "task" {
  for_each    = local.services
  name        = "${local.name}-${each.key}"
  description = "${each.key} tasks"
  vpc_id      = aws_vpc.main.id
}

resource "aws_vpc_security_group_egress_rule" "task_all" {
  for_each          = toset(["api", "worker"])
  security_group_id = aws_security_group.task[each.key].id
  cidr_ipv4         = "0.0.0.0/0"
  ip_protocol       = "-1"
  description       = "Egress via NAT (Claude API, FDA data, SSO providers)"
}

# docproc: VPC-internal egress only (database, S3 gateway endpoint, AWS endpoints).
resource "aws_vpc_security_group_egress_rule" "docproc_vpc" {
  security_group_id = aws_security_group.task["docproc"].id
  cidr_ipv4         = var.vpc_cidr
  ip_protocol       = "-1"
  description       = "VPC-internal only"
}

data "aws_ec2_managed_prefix_list" "s3" {
  name = "com.amazonaws.${var.region}.s3"
}

resource "aws_vpc_security_group_egress_rule" "docproc_s3" {
  security_group_id = aws_security_group.task["docproc"].id
  prefix_list_id    = data.aws_ec2_managed_prefix_list.s3.id
  ip_protocol       = "tcp"
  from_port         = 443
  to_port           = 443
  description       = "S3 through the gateway endpoint"
}

resource "aws_vpc_security_group_ingress_rule" "api_from_alb" {
  security_group_id            = aws_security_group.task["api"].id
  referenced_security_group_id = aws_security_group.alb.id
  from_port                    = 3000
  to_port                      = 3000
  ip_protocol                  = "tcp"
  description                  = "API from the load balancer"
}

# --- Task definitions and services -------------------------------------------------

locals {
  public_base_url = var.app_domain != "" ? "https://${var.app_domain}" : "https://${aws_cloudfront_distribution.web.domain_name}"

  common_env = [
    { name = "NODE_ENV", value = "production" },
    { name = "APP_ENVIRONMENT", value = var.environment },
    { name = "AWS_REGION", value = var.region },
    { name = "APP_BASE_URL", value = local.public_base_url },
    { name = "CORS_ORIGIN", value = local.public_base_url },
    { name = "DB_HOST", value = aws_db_instance.main.address },
    { name = "DB_PORT", value = tostring(aws_db_instance.main.port) },
    { name = "DB_NAME", value = aws_db_instance.main.db_name },
    { name = "DB_SSL", value = "true" },
    { name = "REDIS_URL", value = "rediss://${aws_elasticache_replication_group.main.primary_endpoint_address}:6379" },
    { name = "S3_ENDPOINT", value = "https://s3.${var.region}.amazonaws.com" },
    { name = "S3_REGION", value = var.region },
    { name = "S3_BUCKET", value = aws_s3_bucket.client.bucket },
    { name = "S3_FORCE_PATH_STYLE", value = "false" },
    { name = "LOG_FORMAT", value = "json" },
  ]

  db_secret = aws_db_instance.main.master_user_secret[0].secret_arn
  common_secrets = [
    { name = "DB_USER", valueFrom = "${local.db_secret}:username::" },
    { name = "DB_PASSWORD", valueFrom = "${local.db_secret}:password::" },
    { name = "JWT_SECRET", valueFrom = "${aws_secretsmanager_secret.app.arn}:JWT_SECRET::" },
    { name = "ENCRYPTION_KEY", valueFrom = "${aws_secretsmanager_secret.app.arn}:ENCRYPTION_KEY::" },
    { name = "REDIS_AUTH_TOKEN", valueFrom = aws_secretsmanager_secret.redis_auth.arn },
  ]

  task_sizes = {
    api     = { cpu = var.api_cpu, memory = var.api_memory }
    worker  = { cpu = 1024, memory = 2048 }
    docproc = { cpu = 2048, memory = 4096 }
  }
  commands = {
    api     = null
    worker  = ["node", "dist/worker.js"]
    docproc = null
  }
}

resource "aws_ecs_task_definition" "svc" {
  for_each                 = local.services
  family                   = "${local.name}-${each.key}"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = local.task_sizes[each.key].cpu
  memory                   = local.task_sizes[each.key].memory
  execution_role_arn       = aws_iam_role.execution.arn
  task_role_arn            = aws_iam_role.task[each.key].arn
  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = "ARM64"
  }
  container_definitions = jsonencode([{
    name                   = each.key
    image                  = "${aws_ecr_repository.svc[each.key].repository_url}:${var.image_tag}"
    essential              = true
    command                = local.commands[each.key]
    readonlyRootFilesystem = each.key == "docproc"
    portMappings           = each.key == "api" ? [{ containerPort = 3000, protocol = "tcp" }] : []
    environment            = concat(local.common_env, [{ name = "SERVICE_ROLE", value = each.key }])
    secrets                = local.common_secrets
    logConfiguration = {
      logDriver = "awslogs"
      options = {
        awslogs-group         = aws_cloudwatch_log_group.svc[each.key].name
        awslogs-region        = var.region
        awslogs-stream-prefix = each.key
      }
    }
  }])
}

resource "aws_ecs_service" "svc" {
  for_each               = local.services
  name                   = each.key
  cluster                = aws_ecs_cluster.main.id
  task_definition        = aws_ecs_task_definition.svc[each.key].arn
  launch_type            = "FARGATE"
  desired_count          = each.key == "api" ? var.api_desired_count : each.key == "worker" ? var.worker_desired_count : 0
  enable_execute_command = false
  propagate_tags         = "SERVICE"
  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }
  network_configuration {
    subnets          = each.key == "docproc" ? aws_subnet.isolated[*].id : aws_subnet.private[*].id
    security_groups  = [aws_security_group.task[each.key].id]
    assign_public_ip = false
  }
  dynamic "load_balancer" {
    for_each = each.key == "api" ? [1] : []
    content {
      target_group_arn = aws_lb_target_group.api.arn
      container_name   = "api"
      container_port   = 3000
    }
  }
  lifecycle {
    ignore_changes = [desired_count]
  }
  depends_on = [aws_lb_listener.http]
}

# --- Autoscaling ----------------------------------------------------------------------
# api scales on CPU; worker and docproc get bounds here and are scaled on queue depth by
# a CloudWatch metric the worker publishes (MedexRegAI/Queue Depth), wired in F8.x.

locals {
  scaling = {
    api     = { min = var.api_desired_count, max = var.api_max_count }
    worker  = { min = var.worker_desired_count, max = var.worker_max_count }
    docproc = { min = 0, max = var.docproc_max_count }
  }
}

resource "aws_appautoscaling_target" "svc" {
  for_each           = local.services
  service_namespace  = "ecs"
  resource_id        = "service/${aws_ecs_cluster.main.name}/${aws_ecs_service.svc[each.key].name}"
  scalable_dimension = "ecs:service:DesiredCount"
  min_capacity       = local.scaling[each.key].min
  max_capacity       = local.scaling[each.key].max
}

resource "aws_appautoscaling_policy" "api_cpu" {
  name               = "${local.name}-api-cpu"
  service_namespace  = "ecs"
  resource_id        = aws_appautoscaling_target.svc["api"].resource_id
  scalable_dimension = aws_appautoscaling_target.svc["api"].scalable_dimension
  policy_type        = "TargetTrackingScaling"
  target_tracking_scaling_policy_configuration {
    target_value = 60
    predefined_metric_specification {
      predefined_metric_type = "ECSServiceAverageCPUUtilization"
    }
  }
}
