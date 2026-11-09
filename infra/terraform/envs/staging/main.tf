# MedexRegAI staging. Plan/apply from this directory:
#   terraform init -backend-config=backend.hcl
#   terraform plan -var-file=staging.tfvars
terraform {
  required_version = ">= 1.6"
  # State lives in S3 with locking; bucket/table names come from backend.hcl
  # (see backend.hcl.example) so no account details are committed.
  backend "s3" {
    key     = "medexregai/staging/terraform.tfstate"
    encrypt = true
  }
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.70"
    }
  }
}

provider "aws" {
  region = var.region
  default_tags {
    tags = {
      Project     = "medexregai"
      Environment = "staging"
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

variable "image_tag" {
  type    = string
  default = "latest"
}

module "platform" {
  source = "../../modules/platform"

  environment         = "staging"
  region              = var.region
  app_domain          = var.app_domain
  acm_certificate_arn = var.acm_certificate_arn
  image_tag           = var.image_tag

  vpc_cidr           = "10.41.0.0/16"
  az_count           = 2
  single_nat_gateway = true

  db_instance_class        = "db.t4g.large"
  db_allocated_storage_gb  = 100
  db_multi_az              = false
  db_backup_retention_days = 7

  redis_node_type = "cache.t4g.small"
  redis_replicas  = 0

  api_desired_count    = 1
  api_max_count        = 4
  worker_desired_count = 1
  worker_max_count     = 4
  docproc_max_count    = 4

  deletion_protection = true
  log_retention_days  = 30
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
