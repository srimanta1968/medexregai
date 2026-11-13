# MedexRegAI production. Plan/apply from this directory:
#   terraform init -backend-config=backend.hcl
#   terraform plan -var-file=production.tfvars
terraform {
  required_version = ">= 1.6"
  # State lives in S3 with locking; bucket/table names come from backend.hcl
  # (see backend.hcl.example) so no account details are committed.
  backend "s3" {
    key     = "medexregai/production/terraform.tfstate"
    encrypt = true
  }
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.72"
    }
  }
}

provider "aws" {
  region = var.region
  default_tags {
    tags = {
      Project     = "medexregai"
      Environment = "production"
      ManagedBy   = "terraform"
    }
  }
}

variable "region" {
  type    = string
  default = "us-east-1"
}

variable "app_domain" {
  type    = string
  default = ""
}

variable "acm_certificate_arn" {
  type    = string
  default = ""
}

variable "origin_domain" {
  type    = string
  default = ""
}

variable "origin_certificate_arn" {
  type    = string
  default = ""
}

variable "image_tag" {
  type    = string
  default = "latest"
}

module "platform" {
  source = "../../modules/platform"

  environment         = "production"
  region              = var.region
  app_domain          = var.app_domain
  acm_certificate_arn = var.acm_certificate_arn
  # F4.4: CloudFront to load balancer over HTTPS (required here).
  origin_domain          = var.origin_domain
  origin_certificate_arn = var.origin_certificate_arn
  require_origin_https   = true
  image_tag              = var.image_tag

  vpc_cidr           = "10.42.0.0/16"
  az_count           = 3
  single_nat_gateway = false

  db_instance_class        = "db.r7g.large"
  db_allocated_storage_gb  = 200
  db_multi_az              = true
  db_backup_retention_days = 35

  redis_node_type = "cache.r7g.large"
  redis_replicas  = 1

  api_desired_count    = 2
  api_max_count        = 10
  worker_desired_count = 2
  worker_max_count     = 10
  docproc_max_count    = 8

  deletion_protection = true
  log_retention_days  = 365
}

output "platform" {
  value = {
    app_url          = module.platform.app_url
    web_bucket       = module.platform.web_bucket
    client_bucket    = module.platform.client_bucket
    ecr_repositories = module.platform.ecr_repositories
    ecs_cluster      = module.platform.ecs_cluster
    app_secret_arn   = module.platform.app_secret_arn
  }
}
