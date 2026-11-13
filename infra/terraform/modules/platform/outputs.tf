output "app_url" {
  description = "Public URL of the web app and API."
  value       = local.public_base_url
}

output "cloudfront_distribution_id" {
  value = aws_cloudfront_distribution.web.id
}

output "web_bucket" {
  description = "Upload the built client (client/dist) here."
  value       = aws_s3_bucket.web.bucket
}

output "client_bucket" {
  value = aws_s3_bucket.client.bucket
}

output "ecr_repositories" {
  value = merge({ for k, r in aws_ecr_repository.svc : k => r.repository_url }, { pgbouncer = aws_ecr_repository.pgbouncer.repository_url })
}

output "migrate_task_definition" {
  description = "Run once per deploy, before api/worker roll out (see pgbouncer.tf)."
  value       = aws_ecs_task_definition.migrate.arn
}

output "app_db_secret_arn" {
  description = "medexregai_app login; give the role this password once (docs/ops/runbooks.md section 6)."
  value       = aws_secretsmanager_secret.app_db.arn
}

output "ecs_cluster" {
  value = aws_ecs_cluster.main.name
}

output "db_endpoint" {
  value = aws_db_instance.main.address
}

output "db_master_secret_arn" {
  description = "Secrets Manager secret with the RDS master credentials (rotated by RDS)."
  value       = aws_db_instance.main.master_user_secret[0].secret_arn
}

output "app_secret_arn" {
  description = "Add SSO client secrets and AI_API_KEY to this secret."
  value       = aws_secretsmanager_secret.app.arn
}

output "redis_endpoint" {
  value = aws_elasticache_replication_group.main.primary_endpoint_address
}

output "platform_kms_key_arn" {
  value = aws_kms_key.platform.arn
}

output "fda_db_endpoint" {
  value = aws_db_instance.fda.address
}

output "fda_db_master_secret_arn" {
  description = "RDS master credentials of the FDA corpus database."
  value       = aws_db_instance.fda.master_user_secret[0].secret_arn
}

output "fda_service_url" {
  description = "Internal URL of fda-data /v1 (set as FDA_SERVICE_URL on app tasks)."
  value       = "http://fda-api.${aws_service_discovery_private_dns_namespace.internal.name}:4100"
}

output "fda_ecr_repository" {
  value = aws_ecr_repository.fda.repository_url
}

output "alb_dns_name" {
  description = "Point origin_domain (CNAME or Route 53 alias) here."
  value       = aws_lb.api.dns_name
}
