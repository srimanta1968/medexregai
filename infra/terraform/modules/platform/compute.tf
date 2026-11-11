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

# JWT and field-encryption keys are generated once; SSO client secrets, the
# Claude API key and the fda-data service key are added by an operator (empty here).
resource "aws_secretsmanager_secret_version" "app" {
  secret_id = aws_secretsmanager_secret.app.id
  secret_string = jsonencode({
    JWT_SECRET                  = random_password.jwt.result
    ENCRYPTION_KEY              = random_id.encryption_key.hex
    SSO_GOOGLE_CLIENT_SECRET    = ""
    SSO_MICROSOFT_CLIENT_SECRET = ""
    AI_API_KEY                  = ""
    FDA_SERVICE_KEY             = ""
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
      aws_secretsmanager_secret.docproc.arn,
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

# api and worker read/write the client bucket. Objects under a tenant prefix are
# encrypted with that tenant's key; the app may only use keys tagged as tenant keys.
# docproc gets none of this: the worker posts it the bytes (docproc.tf).
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
  for_each = toset(["api", "worker"])
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

# docproc egress and ingress: docproc.tf (AWS endpoints only; worker on 4200).

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
    { name = "TRUST_PROXY", value = "2" }, # CloudFront + ALB
    { name = "FDA_SERVICE_URL", value = "http://fda-api.${aws_service_discovery_private_dns_namespace.internal.name}:4100" },
  ]

  db_secret = aws_db_instance.main.master_user_secret[0].secret_arn
  common_secrets = [
    { name = "DB_USER", valueFrom = "${local.db_secret}:username::" },
    { name = "DB_PASSWORD", valueFrom = "${local.db_secret}:password::" },
    { name = "JWT_SECRET", valueFrom = "${aws_secretsmanager_secret.app.arn}:JWT_SECRET::" },
    { name = "ENCRYPTION_KEY", valueFrom = "${aws_secretsmanager_secret.app.arn}:ENCRYPTION_KEY::" },
    { name = "REDIS_AUTH_TOKEN", valueFrom = aws_secretsmanager_secret.redis_auth.arn },
  ]

  docproc_url = "http://docproc.${aws_service_discovery_private_dns_namespace.internal.name}:4200"
  docproc_key = [{ name = "DOCPROC_API_KEY", valueFrom = aws_secretsmanager_secret.docproc.arn }]

  # docproc gets no database, cache or bucket settings and only its own key.
  service_env = {
    api    = concat(local.common_env, [{ name = "DOCPROC_URL", value = local.docproc_url }])
    worker = concat(local.common_env, [{ name = "DOCPROC_URL", value = local.docproc_url }, { name = "DOCPROC_QUEUE_METRIC", value = "true" }])
    docproc = [
      { name = "DOCPROC_PARSE_TIMEOUT_S", value = tostring(var.docproc_parse_timeout_s) },
      { name = "DOCPROC_CONCURRENCY", value = "1" },
    ]
  }
  service_secrets = {
    api     = concat(local.common_secrets, local.docproc_key)
    worker  = concat(local.common_secrets, local.docproc_key)
    docproc = local.docproc_key
  }
  service_ports = {
    api     = [{ containerPort = 3000, protocol = "tcp" }]
    worker  = []
    docproc = [{ containerPort = 4200, protocol = "tcp" }]
  }

  # Container settings only the docproc sandbox gets (ADR-013).
  container_extras = {
    api    = {}
    worker = {}
    docproc = {
      user        = "10001"
      mountPoints = [{ sourceVolume = "scratch", containerPath = "/tmp", readOnly = false }]
      linuxParameters = {
        initProcessEnabled = true
        capabilities       = { add = [], drop = ["ALL"] }
      }
      healthCheck = {
        command     = ["CMD", "python", "-c", "import urllib.request;urllib.request.urlopen('http://127.0.0.1:4200/health',timeout=2)"]
        interval    = 30
        timeout     = 5
        retries     = 3
        startPeriod = 20
      }
    }
  }

  task_sizes = {
    api     = { cpu = var.api_cpu, memory = var.api_memory }
    worker  = { cpu = 1024, memory = 2048 }
    docproc = { cpu = var.docproc_cpu, memory = var.docproc_memory }
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
  # docproc sandbox (ADR-013): read-only root with a scratch /tmp, every Linux capability
  # dropped, non-root user from the image, killed children reaped by init.
  dynamic "volume" {
    for_each = each.key == "docproc" ? [1] : []
    content {
      name = "scratch"
    }
  }
  container_definitions = jsonencode([merge({
    name                   = each.key
    image                  = "${aws_ecr_repository.svc[each.key].repository_url}:${var.image_tag}"
    essential              = true
    command                = local.commands[each.key]
    readonlyRootFilesystem = each.key == "docproc"
    portMappings           = local.service_ports[each.key]
    environment            = concat(local.service_env[each.key], [{ name = "SERVICE_ROLE", value = each.key }])
    secrets                = local.service_secrets[each.key]
    logConfiguration = {
      logDriver = "awslogs"
      options = {
        awslogs-group         = aws_cloudwatch_log_group.svc[each.key].name
        awslogs-region        = var.region
        awslogs-stream-prefix = each.key
      }
    }
  }, local.container_extras[each.key])])
}

resource "aws_ecs_service" "svc" {
  for_each               = local.services
  name                   = each.key
  cluster                = aws_ecs_cluster.main.id
  task_definition        = aws_ecs_task_definition.svc[each.key].arn
  launch_type            = "FARGATE"
  desired_count          = each.key == "api" ? var.api_desired_count : each.key == "worker" ? var.worker_desired_count : var.docproc_min_count
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
  dynamic "service_registries" {
    for_each = each.key == "docproc" ? [1] : []
    content {
      registry_arn = aws_service_discovery_service.docproc.arn
    }
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
# api scales on CPU; docproc scales on the ingest queue depth the worker publishes
# (MedexRegAI/Ingest QueueDepth, policies in docproc.tf); worker gets bounds here and
# its own queue-depth scaling with the F8 job framework.

locals {
  scaling = {
    api     = { min = var.api_desired_count, max = var.api_max_count }
    worker  = { min = var.worker_desired_count, max = var.worker_max_count }
    docproc = { min = var.docproc_min_count, max = var.docproc_max_count }
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
