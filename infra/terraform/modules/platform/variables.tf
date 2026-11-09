variable "environment" {
  description = "dev, staging or production."
  type        = string
  validation {
    condition     = contains(["dev", "staging", "production"], var.environment)
    error_message = "environment must be dev, staging or production."
  }
}

variable "region" {
  description = "AWS region. ADR-001: one US region."
  type        = string
  validation {
    condition     = can(regex("^us-(east|west)-[12]$", var.region))
    error_message = "ADR-001 keeps all data in one US region (us-east-1/2 or us-west-1/2)."
  }
}

variable "app_domain" {
  description = "Public hostname for the web app and API (same origin), e.g. app.example.com. Empty = CloudFront default domain."
  type        = string
  default     = ""
}

variable "acm_certificate_arn" {
  description = "ACM certificate (us-east-1) for app_domain. Required when app_domain is set."
  type        = string
  default     = ""
}

variable "vpc_cidr" {
  type    = string
  default = "10.40.0.0/16"
}

variable "az_count" {
  description = "Availability zones used (2 or 3)."
  type        = number
  default     = 2
}

variable "single_nat_gateway" {
  description = "One NAT gateway for all AZs (cheaper; dev/staging) instead of one per AZ."
  type        = bool
  default     = true
}

variable "db_instance_class" {
  type    = string
  default = "db.t4g.medium"
}

variable "db_allocated_storage_gb" {
  type    = number
  default = 50
}

variable "db_multi_az" {
  type    = bool
  default = false
}

variable "db_backup_retention_days" {
  type    = number
  default = 7
}

variable "redis_node_type" {
  type    = string
  default = "cache.t4g.small"
}

variable "redis_replicas" {
  description = "Read replicas per shard (0 = single node)."
  type        = number
  default     = 0
}

variable "api_cpu" {
  type    = number
  default = 512
}

variable "api_memory" {
  type    = number
  default = 1024
}

variable "api_desired_count" {
  type    = number
  default = 1
}

variable "api_max_count" {
  type    = number
  default = 4
}

variable "worker_desired_count" {
  type    = number
  default = 1
}

variable "worker_max_count" {
  type    = number
  default = 4
}

variable "docproc_max_count" {
  description = "Upper bound of the sandboxed document-conversion pool (scaled on queue depth)."
  type        = number
  default     = 4
}

variable "image_tag" {
  description = "Container image tag deployed for api, worker and docproc."
  type        = string
  default     = "latest"
}

variable "deletion_protection" {
  description = "Protect the database and buckets from accidental destroy."
  type        = bool
  default     = true
}

variable "log_retention_days" {
  type    = number
  default = 30
}

variable "tags" {
  type    = map(string)
  default = {}
}
