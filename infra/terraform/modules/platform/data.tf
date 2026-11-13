# --- Encryption keys ---------------------------------------------------------
# Platform key: RDS, ElastiCache, logs, secrets and the bucket default.
# Per-tenant keys (NFR-8) are created by the application at firm onboarding and
# must carry the tag medexregai:tenant=<org id>; the IAM policy in compute.tf lets
# the app create and use ONLY keys carrying that tag.

resource "aws_kms_key" "platform" {
  description             = "${local.name} platform data key"
  enable_key_rotation     = true
  deletion_window_in_days = 30
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid       = "AccountAdmin"
        Effect    = "Allow"
        Principal = { AWS = "arn:aws:iam::${local.account_id}:root" }
        Action    = "kms:*"
        Resource  = "*"
      },
      {
        Sid       = "CloudWatchLogs"
        Effect    = "Allow"
        Principal = { Service = "logs.${var.region}.amazonaws.com" }
        Action    = ["kms:Encrypt*", "kms:Decrypt*", "kms:ReEncrypt*", "kms:GenerateDataKey*", "kms:Describe*"]
        Resource  = "*"
        Condition = { ArnLike = { "kms:EncryptionContext:aws:logs:arn" = "arn:aws:logs:${var.region}:${local.account_id}:*" } }
      }
    ]
  })
}

resource "aws_kms_alias" "platform" {
  name          = "alias/${local.name}-platform"
  target_key_id = aws_kms_key.platform.key_id
}

# --- PostgreSQL 16 with pgvector ----------------------------------------------
# pgvector is available on RDS for PostgreSQL; the app's migration 001 runs
# CREATE EXTENSION vector. RLS policies (F8.1) need a non-superuser app role,
# which the migration creates; the master user is only for migrations.

resource "aws_db_subnet_group" "main" {
  name       = "${local.name}-db"
  subnet_ids = aws_subnet.private[*].id
}

resource "aws_security_group" "db" {
  name        = "${local.name}-db"
  description = "PostgreSQL from app tasks only" # unchanged on purpose: a new description replaces the group; ingress is PgBouncer + migrations (pgbouncer.tf)
  vpc_id      = aws_vpc.main.id
}

# Direct access only for the one-off migrate task (runs on the api security group); api and worker
# traffic goes through PgBouncer (pgbouncer.tf), and docproc never touches the database.
resource "aws_vpc_security_group_ingress_rule" "db_from_tasks" {
  for_each                     = toset(["api"])
  security_group_id            = aws_security_group.db.id
  referenced_security_group_id = aws_security_group.task[each.key].id
  from_port                    = 5432
  to_port                      = 5432
  ip_protocol                  = "tcp"
  description                  = "PostgreSQL from migrations (api security group)"
}

resource "aws_db_parameter_group" "pg16" {
  name   = "${local.name}-pg16"
  family = "postgres16"
  parameter {
    name  = "rds.force_ssl"
    value = "1"
  }
  parameter {
    name  = "log_min_duration_statement"
    value = "500"
  }
}

resource "aws_db_instance" "main" {
  identifier                      = "${local.name}-pg"
  engine                          = "postgres"
  engine_version                  = "16"
  instance_class                  = var.db_instance_class
  allocated_storage               = var.db_allocated_storage_gb
  max_allocated_storage           = var.db_allocated_storage_gb * 4
  storage_type                    = "gp3"
  storage_encrypted               = true
  kms_key_id                      = aws_kms_key.platform.arn
  db_name                         = "medexregai"
  username                        = "medexregai_admin"
  manage_master_user_password     = true
  master_user_secret_kms_key_id   = aws_kms_key.platform.arn
  db_subnet_group_name            = aws_db_subnet_group.main.name
  vpc_security_group_ids          = [aws_security_group.db.id]
  parameter_group_name            = aws_db_parameter_group.pg16.name
  multi_az                        = var.db_multi_az
  backup_retention_period         = var.db_backup_retention_days
  deletion_protection             = var.deletion_protection
  skip_final_snapshot             = !var.deletion_protection
  final_snapshot_identifier       = var.deletion_protection ? "${local.name}-pg-final" : null
  performance_insights_enabled    = true
  performance_insights_kms_key_id = aws_kms_key.platform.arn
  auto_minor_version_upgrade      = true
  copy_tags_to_snapshot           = true
  publicly_accessible             = false
  enabled_cloudwatch_logs_exports = ["postgresql"]
}

# --- Redis (ElastiCache) -------------------------------------------------------

resource "aws_elasticache_subnet_group" "main" {
  name       = "${local.name}-redis"
  subnet_ids = aws_subnet.private[*].id
}

resource "aws_security_group" "redis" {
  name        = "${local.name}-redis"
  description = "Redis from api and worker tasks only"
  vpc_id      = aws_vpc.main.id
}

resource "aws_vpc_security_group_ingress_rule" "redis_from_tasks" {
  for_each                     = toset(["api", "worker"])
  security_group_id            = aws_security_group.redis.id
  referenced_security_group_id = aws_security_group.task[each.key].id
  from_port                    = 6379
  to_port                      = 6379
  ip_protocol                  = "tcp"
  description                  = "Redis from ${each.key}"
}

resource "random_password" "redis_auth" {
  length  = 48
  special = false
}

resource "aws_secretsmanager_secret" "redis_auth" {
  name       = "${local.name}/redis-auth"
  kms_key_id = aws_kms_key.platform.arn
}

resource "aws_secretsmanager_secret_version" "redis_auth" {
  secret_id     = aws_secretsmanager_secret.redis_auth.id
  secret_string = random_password.redis_auth.result
}

resource "aws_elasticache_replication_group" "main" {
  replication_group_id       = "${local.name}-redis"
  description                = "${local.name} cache and rate limits"
  engine                     = "redis"
  engine_version             = "7.1"
  node_type                  = var.redis_node_type
  num_cache_clusters         = 1 + var.redis_replicas
  automatic_failover_enabled = var.redis_replicas > 0
  multi_az_enabled           = var.redis_replicas > 0
  subnet_group_name          = aws_elasticache_subnet_group.main.name
  security_group_ids         = [aws_security_group.redis.id]
  at_rest_encryption_enabled = true
  kms_key_id                 = aws_kms_key.platform.arn
  transit_encryption_enabled = true
  auth_token                 = random_password.redis_auth.result
  snapshot_retention_limit   = var.environment == "production" ? 7 : 0
}

# --- S3: client documents (per-tenant prefix + per-tenant KMS key) and exports --

resource "aws_s3_bucket" "client" {
  bucket        = "${local.name}-client-${local.account_id}"
  force_destroy = !var.deletion_protection
}

resource "aws_s3_bucket_public_access_block" "client" {
  bucket                  = aws_s3_bucket.client.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_ownership_controls" "client" {
  bucket = aws_s3_bucket.client.id
  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

resource "aws_s3_bucket_versioning" "client" {
  bucket = aws_s3_bucket.client.id
  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "client" {
  bucket = aws_s3_bucket.client.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm     = "aws:kms"
      kms_master_key_id = aws_kms_key.platform.arn
    }
    bucket_key_enabled = true
  }
}

# Fetched copies are job-scoped (ADR: deleted on completion); this rule is the
# safety net. Old versions expire so per-project deletion is final after 30 days.
resource "aws_s3_bucket_lifecycle_configuration" "client" {
  bucket = aws_s3_bucket.client.id
  rule {
    id     = "expire-job-scratch"
    status = "Enabled"
    filter {
      prefix = "scratch/"
    }
    expiration {
      days = 1
    }
  }
  rule {
    id     = "expire-noncurrent"
    status = "Enabled"
    filter {}
    noncurrent_version_expiration {
      noncurrent_days = 30
    }
    abort_incomplete_multipart_upload {
      days_after_initiation = 2
    }
  }
}

resource "aws_s3_bucket_policy" "client_tls_only" {
  bucket = aws_s3_bucket.client.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid       = "DenyInsecureTransport"
      Effect    = "Deny"
      Principal = "*"
      Action    = "s3:*"
      Resource  = [aws_s3_bucket.client.arn, "${aws_s3_bucket.client.arn}/*"]
      Condition = { Bool = { "aws:SecureTransport" = "false" } }
    }]
  })
}
