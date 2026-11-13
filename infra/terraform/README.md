# MedexRegAI infrastructure (Terraform)

AWS, one US region (ADR-001). `modules/platform` is the whole stack; `envs/dev`,
`envs/staging` and `envs/production` call it with their own sizing and their own
state file.

| Piece | What | Notes |
|---|---|---|
| Network | VPC, public / private / isolated subnets per AZ | Isolated subnets have no internet route; docproc runs there (ADR-013) and reaches AWS via VPC endpoints |
| Compute | ECS Fargate (ARM64): `api`, `worker`, `docproc` | api behind an ALB; api scales on CPU; docproc keeps one warm task and scales on the ingest queue depth the worker logs (docproc.tf); worker bounded, its queue-depth scaling arrives with F8 |
| Database | RDS PostgreSQL 16 (pgvector available) | Master password managed by RDS in Secrets Manager; `rds.force_ssl=1`; Multi-AZ in production |
| Pooling | PgBouncer on ECS (`pgbouncer.tf`), transaction mode | api and worker connect as `medexregai_app` (row-level security) through `pgbouncer.<env>.internal:6432`; PgBouncer verifies RDS over TLS; migrations run as the one-off `migrate` task straight to RDS with the master login |
| Cache | ElastiCache Redis 7.1 | TLS + AUTH token (Secrets Manager); replica + failover in production |
| Files | S3 client bucket | Versioned, TLS-only; every object SSE-KMS under its firm's own KMS key (created by the API on the firm's first upload, tagged `medexregai:tenant`, rotation on, recorded in `org_storage_keys`); keys under `orgs/<firm id>/`; uploads without KMS are refused by bucket policy; the API uses the task role, no static keys |
| Edge | CloudFront | SPA from S3 plus `/api/*` to the ALB on one origin; the ALB accepts only CloudFront with a secret header |

| | dev | staging | production |
|---|---|---|---|
| AZs / NAT | 2 / shared | 2 / shared | 3 / one per AZ |
| Postgres | t4g.medium, single-AZ | t4g.large | r7g.large, Multi-AZ, 35-day backups |
| Redis | t4g.small | t4g.small | r7g.large + replica |
| Deletion protection | off | on | on |

## Use

```bash
cd envs/dev
cp backend.hcl.example backend.hcl        # fill in the state bucket and lock table
terraform init -backend-config=backend.hcl
terraform plan -var-file=dev.tfvars
terraform apply -var-file=dev.tfvars      # creates billable AWS resources
```

After the first apply:

1. Push images to the ECR repositories in the `platform.ecr_repositories` output (`pgbouncer` is built from `infra/docker/pgbouncer`).
   Run the `platform.migrate_task_definition` task, then give `medexregai_app` its password from `platform.app_db_secret_arn` (docs/ops/runbooks.md section 6).
2. Put SSO client secrets and `AI_API_KEY` into the `platform.app_secret_arn` secret.
3. Upload `client/dist` to `platform.web_bucket` and invalidate CloudFront.

## Known gaps (tracked, not yet in the app)

- The `migrate` task connects to RDS with `DB_MIGRATION_SSL=true` (certificate verified); Node does not trust the Amazon RDS CA by default, so the api image must ship the RDS bundle and set `NODE_EXTRA_CA_CERTS` (with the Dockerfiles). App traffic is unaffected: PgBouncer verifies RDS with the bundle in its image.

- The worker entrypoint (`dist/worker.js`), Dockerfiles and the docproc image arrive with the CI/CD and worker tasks.
- CloudFront reaches the ALB over HTTPS (TLS 1.2+) when `origin_domain` and `origin_certificate_arn` are set: create a hostname such as `origin.app.example.com` as a CNAME (or Route 53 alias) to the `alb_dns_name` output, and an ACM certificate for it in the ALB's region. Staging and production refuse to plan without them (`require_origin_https`); dev may run without (HTTP to the ALB). The ALB to API tasks hop stays HTTP inside the VPC.

## fda-data service (ADR-017)

`modules/platform/fda_data.tf` adds the FDA data service with its **own** RDS
PostgreSQL instance (`fda_db`, optional read replica via `fda_db_read_replica`),
ECS services `fda-api` and `fda-worker`, its own secret and execution role, and a
private DNS name `fda-api.<env>.internal:4100` reachable only from the app's api
and worker tasks. App tasks get `FDA_SERVICE_URL`; after the first deploy an
operator creates the app's key inside fda-data
(`npm run clients -- create medexregai-app fda:read fda:track`) and stores it as
`FDA_SERVICE_KEY` in the app secret. Push the image built from `services/fda-data`
to the `fda_ecr_repository` output. Plan only until an AWS account is approved.
