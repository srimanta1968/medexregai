terraform {
  required_version = ">= 1.6"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.70"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.6"
    }
  }
}

data "aws_caller_identity" "current" {}

locals {
  name       = "medexregai-${var.environment}"
  account_id = data.aws_caller_identity.current.account_id
  services   = toset(["api", "worker", "docproc"])
}
