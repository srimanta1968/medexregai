# Non-secret settings for staging. Secrets never go in tfvars: they live in Secrets Manager.
region = "us-east-1"
# app_domain          = "staging.medexregai.example"
# acm_certificate_arn = "arn:aws:acm:us-east-1:<account>:certificate/<id>"
# origin_domain          = "origin.staging.medexregai.example"   # CNAME to output alb_dns_name
# origin_certificate_arn = "arn:aws:acm:<region>:<account>:certificate/<id>"  # same region as the ALB
