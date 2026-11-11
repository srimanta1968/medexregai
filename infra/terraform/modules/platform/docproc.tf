# docproc: the sandboxed document-conversion pool (F7.2, ADR-013).
#
# A client file is hostile until parsed. docproc therefore:
#   - runs in the isolated subnets (no route to the internet, network.tf) and may only
#     reach the AWS interface endpoints it needs to start and log, plus S3 for image layers;
#   - holds no database, cache, bucket or KMS access: the worker posts it the bytes;
#   - accepts connections from the worker and fda-worker only, on 4200, authenticated
#     with its own key;
#   - runs read-only, non-root, with every Linux capability dropped and fixed CPU/memory
#     (compute.tf); each parse also runs in a child process killed at its time limit;
#   - scales on the ingest queue depth the worker publishes, keeping one task warm so a
#     queued file never waits on a cold start long enough to exhaust its retries.

# --- Key the worker sends in X-Docproc-Key -------------------------------------------

resource "random_password" "docproc_key" {
  length  = 48
  special = false
}

resource "aws_secretsmanager_secret" "docproc" {
  name       = "${local.name}/docproc-key"
  kms_key_id = aws_kms_key.platform.arn
}

resource "aws_secretsmanager_secret_version" "docproc" {
  secret_id     = aws_secretsmanager_secret.docproc.id
  secret_string = random_password.docproc_key.result
}

# --- Network: worker in, AWS endpoints out -----------------------------------------------

resource "aws_vpc_security_group_ingress_rule" "docproc_from_worker" {
  security_group_id            = aws_security_group.task["docproc"].id
  referenced_security_group_id = aws_security_group.task["worker"].id
  from_port                    = 4200
  to_port                      = 4200
  ip_protocol                  = "tcp"
  description                  = "docproc /v1 from the ingest worker"
}

resource "aws_vpc_security_group_ingress_rule" "docproc_from_fda_worker" {
  security_group_id            = aws_security_group.task["docproc"].id
  referenced_security_group_id = aws_security_group.fda_task["fda-worker"].id
  from_port                    = 4200
  to_port                      = 4200
  ip_protocol                  = "tcp"
  description                  = "docproc /v1 from fda-worker (510(k) summary index, F1.2)"
}

resource "aws_vpc_security_group_egress_rule" "worker_to_docproc" {
  security_group_id            = aws_security_group.task["worker"].id
  referenced_security_group_id = aws_security_group.task["docproc"].id
  from_port                    = 4200
  to_port                      = 4200
  ip_protocol                  = "tcp"
  description                  = "Ingest worker to docproc"
}

resource "aws_vpc_security_group_egress_rule" "docproc_endpoints" {
  security_group_id            = aws_security_group.task["docproc"].id
  referenced_security_group_id = aws_security_group.endpoints.id
  from_port                    = 443
  to_port                      = 443
  ip_protocol                  = "tcp"
  description                  = "AWS interface endpoints only (ECR, logs, KMS, Secrets Manager)"
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
  description       = "Image layers from ECR's S3 bucket through the gateway endpoint"
}

# Name the worker uses: http://docproc.<name>.internal:4200 (DOCPROC_URL, compute.tf).
resource "aws_service_discovery_service" "docproc" {
  name = "docproc"
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

# --- Scaling on the ingest queue -------------------------------------------------------
# The worker logs QueueDepth (file versions queued or parsing) every 10 s in CloudWatch
# Embedded Metric Format; CloudWatch Logs turns it into this metric.

locals {
  docproc_queue_metric = {
    namespace  = "MedexRegAI/Ingest"
    name       = "QueueDepth"
    dimensions = { Environment = var.environment }
  }
}

resource "aws_appautoscaling_policy" "docproc_out" {
  name               = "${local.name}-docproc-queue-out"
  service_namespace  = "ecs"
  resource_id        = aws_appautoscaling_target.svc["docproc"].resource_id
  scalable_dimension = aws_appautoscaling_target.svc["docproc"].scalable_dimension
  policy_type        = "StepScaling"
  step_scaling_policy_configuration {
    adjustment_type         = "ChangeInCapacity"
    cooldown                = 120
    metric_aggregation_type = "Maximum"
    step_adjustment {
      metric_interval_lower_bound = 0
      metric_interval_upper_bound = var.docproc_scale_out_depth * 2
      scaling_adjustment          = 1
    }
    step_adjustment {
      metric_interval_lower_bound = var.docproc_scale_out_depth * 2
      scaling_adjustment          = 2
    }
  }
}

resource "aws_appautoscaling_policy" "docproc_in" {
  name               = "${local.name}-docproc-queue-in"
  service_namespace  = "ecs"
  resource_id        = aws_appautoscaling_target.svc["docproc"].resource_id
  scalable_dimension = aws_appautoscaling_target.svc["docproc"].scalable_dimension
  policy_type        = "StepScaling"
  step_scaling_policy_configuration {
    adjustment_type         = "ChangeInCapacity"
    cooldown                = 300
    metric_aggregation_type = "Maximum"
    step_adjustment {
      metric_interval_upper_bound = 0
      scaling_adjustment          = -1
    }
  }
}

resource "aws_cloudwatch_metric_alarm" "docproc_queue_high" {
  alarm_name          = "${local.name}-docproc-queue-high"
  alarm_description   = "Ingest queue is backing up: add docproc tasks"
  namespace           = local.docproc_queue_metric.namespace
  metric_name         = local.docproc_queue_metric.name
  dimensions          = local.docproc_queue_metric.dimensions
  statistic           = "Maximum"
  period              = 60
  evaluation_periods  = 2
  comparison_operator = "GreaterThanOrEqualToThreshold"
  threshold           = var.docproc_scale_out_depth
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_appautoscaling_policy.docproc_out.arn]
}

resource "aws_cloudwatch_metric_alarm" "docproc_queue_idle" {
  alarm_name          = "${local.name}-docproc-queue-idle"
  alarm_description   = "Ingest queue has been empty for 15 minutes: remove a docproc task"
  namespace           = local.docproc_queue_metric.namespace
  metric_name         = local.docproc_queue_metric.name
  dimensions          = local.docproc_queue_metric.dimensions
  statistic           = "Maximum"
  period              = 300
  evaluation_periods  = 3
  comparison_operator = "LessThanOrEqualToThreshold"
  threshold           = 0
  treat_missing_data  = "breaching"
  alarm_actions       = [aws_appautoscaling_policy.docproc_in.arn]
}
