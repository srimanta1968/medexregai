# SOC 2 readiness: control register

Status: started 2026-11-12 (F4.4). Source: Architecture v2.0 (MRA-PRD-203) §13 "Assurance: SOC 2
readiness from Phase 3" (NFR-18).

**What this is.** This is a readiness register, not an attestation. MedexRegAI has no SOC 2 report.
Firms and their clients must not be told otherwise. The register lists the controls we expect an
auditor to test against the AICPA 2017 Trust Services Criteria (revised points of focus, 2022) for
the categories in scope, the evidence that exists today, and what is missing.

**Scope (proposed, TO CONFIRM with the auditor).** Trust Services Categories: Security (Common
Criteria CC1–CC9, required), Confidentiality (C1) and Availability (A1). Processing Integrity and
Privacy are out of scope for the first report. System: the production web app, API, workers,
docproc sandbox, database and object store in one AWS region (ADR-001). Report type: Type I first,
then Type II over an observation period (TO CONFIRM: auditor, dates).

**How it is tracked.** One row per control. Status is one of:
- **In place**: built and evidenced in the repository; still needs operating evidence over time.
- **Partial**: some of it exists; the gap is stated.
- **Not started**: nothing yet.

Review the register monthly and at each release. Change a status only with a pointer to the
evidence. Evidence that lives outside the repository (screenshots, tickets, signed policies) goes
in the evidence store (TO CONFIRM: location) under the control id.

Summary at start (2026-11-12): 18 in place (one inherited from AWS), 11 partial, 15 not started, out of 44.

---

## CC1 Control environment

| Id | Control | Status | Evidence / gap | Owner |
|---|---|---|---|---|
| CC1-01 | Information security policy, approved by the founder, reviewed yearly | Not started | No written policy yet | Founder |
| CC1-02 | Code of conduct and acceptable-use policy acknowledged by every staff member and contractor | Not started | | Founder |
| CC1-03 | Background checks for staff with production access | Not started | | Founder |
| CC1-04 | Roles and security responsibilities written down (who owns security, on call, access approval) | Partial | On-call role assumed in docs/ops/runbooks.md; no written assignment | Founder |
| CC1-05 | Security awareness training at hire and yearly | Not started | | Founder |

## CC2 Communication and information

| Id | Control | Status | Evidence / gap | Owner |
|---|---|---|---|---|
| CC2-01 | System description for customers: what we hold, where, for how long, who processes it | In place | Trust pack (F7.4): server/src/trust/content.ts, /app/trust-pack | Engineering |
| CC2-02 | Customers told how to report a security issue, and how we tell them of incidents | Partial | Trust pack describes handling; no published security contact or disclosure policy | Founder |
| CC2-03 | Internal channel and record for security incidents | Partial | Incident notes required by docs/ops/runbooks.md; no tracker chosen | Engineering |

## CC3 Risk assessment

| Id | Control | Status | Evidence / gap | Owner |
|---|---|---|---|---|
| CC3-01 | Yearly risk assessment, including fraud risk and AI-specific risks (prompt injection, wrong citations) | Partial | AI risks are designed for (ADR-016, citation gate, docs/ai/model-card.md); no written risk register | Founder |
| CC3-02 | Vendor and subprocessor list with a risk review of each (AWS, AI provider, connector providers, email) | Not started | | Founder |

## CC4 Monitoring activities

| Id | Control | Status | Evidence / gap | Owner |
|---|---|---|---|---|
| CC4-01 | Register reviewed monthly; deficiencies tracked to closure | In place | This document, from 2026-11-12 | Founder |
| CC4-02 | External penetration test before the first paid live project, findings fixed and retested | Not started | Scope in docs/compliance/pentest-scope.md (F4.4); test not yet run | Engineering |

## CC5 Control activities

| Id | Control | Status | Evidence / gap | Owner |
|---|---|---|---|---|
| CC5-01 | Controls are designed into the product where possible, not left to procedure | In place | Typed confirmation for deletion, permissions per route (server/src/middleware/authorize.ts), deterministic checks before AI (Architecture §1) | Engineering |
| CC5-02 | Written procedures for recurring operations | Partial | Five runbooks in docs/ops/runbooks.md; backup restore and access review procedures missing | Engineering |

## CC6 Logical and physical access

| Id | Control | Status | Evidence / gap | Owner |
|---|---|---|---|---|
| CC6-01 | Tenant isolation: every query on client data runs in one firm's context | Partial | Enforced in the application: DataService checks every table against server/src/db/tableCatalog.ts and sets app.org_id per transaction. Database row-level security policies are not yet created (planned F8.1). Until then isolation rests on application code alone | Engineering |
| CC6-02 | Role-based permissions within a firm (owner, admin, editor, reviewer) | In place | server/src/middleware/authorize.ts; 403 cases in tests/api_definitions/** | Engineering |
| CC6-03 | Passwords stored as salted hashes; short-lived access tokens | In place | bcryptjs; JWT_EXPIRES_IN default 15m with refresh tokens (server/src/config/env.ts) | Engineering |
| CC6-04 | Multi-factor authentication for customer accounts, or SSO with the firm's identity provider | Partial | SSO sign-in exists (server/src/routes/sso.ts); no MFA for password accounts | Engineering |
| CC6-05 | Login throttling or lockout against password guessing | Not started | No rate limiting on auth routes found | Engineering |
| CC6-06 | Staff access to production: individual accounts, MFA, least privilege, removed on leaving | Not started | AWS IAM roles exist in Terraform for services; human access policy not written | Founder |
| CC6-07 | Quarterly review of who has production and admin access | Not started | | Founder |
| CC6-08 | Encryption at rest for database, object store and logs, with managed keys rotated yearly | In place | aws_kms_key.platform with enable_key_rotation; RDS storage_encrypted; S3 SSE-KMS (infra/terraform/modules/platform/data.tf, compute.tf) | Engineering |
| CC6-09 | Encryption in transit | Partial | Viewers: CloudFront redirects to HTTPS, TLSv1.2_2021 minimum when a custom domain is set (edge.tf). Gap: CloudFront to the load balancer is `origin_protocol_policy = "http-only"` (the ALB accepts only CloudFront's prefix list, but the hop is unencrypted); ALB to tasks is HTTP on port 3000. Fix: HTTPS listener with an ACM certificate and `https-only` origin | Engineering |
| CC6-10 | Client object store is not public | In place | aws_s3_bucket_public_access_block "client" (data.tf) | Engineering |
| CC6-11 | Read-only, user-granted access to firm file stores; revocable by the firm | In place | Connectors (F2.1): read-only scopes; disconnect revokes at the provider (server/src/connections/ConnectionService.ts) | Engineering |
| CC6-12 | Untrusted files cannot reach the network or change system behaviour | In place | docproc in a no-egress subnet (docproc.tf); malware scan of uploads (MALWARE_SCAN, required in production); injection handling (ADR-016) | Engineering |
| CC6-13 | Physical security | In place (inherited) | AWS data centres; rely on the AWS SOC 2 report as a carved-out subservice organisation | — |

## CC7 System operations

| Id | Control | Status | Evidence / gap | Owner |
|---|---|---|---|---|
| CC7-01 | Tamper-evident audit log of security-relevant actions | In place | audit_events with hash chain and immutability trigger (server/migrations/007_audit_events.sql); audit middleware on routes | Engineering |
| CC7-02 | Application and infrastructure logs kept for a set period | In place | CloudWatch log groups with retention_in_days = var.log_retention_days (compute.tf) | Engineering |
| CC7-03 | AWS account activity logging and threat detection (CloudTrail, GuardDuty or equal) | Not started | Not in Terraform | Engineering |
| CC7-04 | Alerts for abnormal operation reach a person | Partial | Docproc queue alarms (docproc.tf); AI cost alert email (OPS_ALERT_EMAIL); no paging or uptime alert | Engineering |
| CC7-05 | Vulnerability management: dependency and image scanning, patch window | Not started | No scanning step in .github/workflows/ci.yml | Engineering |
| CC7-06 | Incident response plan, tested yearly | Partial | Runbooks cover five scenarios (docs/ops/runbooks.md); no overall plan, severity scale or customer notice timeline | Founder |

## CC8 Change management

| Id | Control | Status | Evidence / gap | Owner |
|---|---|---|---|---|
| CC8-01 | Every change passes automated checks before release | In place | CI: lint, typecheck, unit tests, injection suite, migrations, build (.github/workflows/ci.yml); evaluation workflow (eval.yml); pre-push API tests | Engineering |
| CC8-02 | Changes are reviewed by a second person before production | Not started | Single developer today; branch protection TO CONFIRM | Founder |
| CC8-03 | Infrastructure changed only through code | In place | Terraform per environment (infra/terraform/envs/*) | Engineering |
| CC8-04 | Database changes are versioned and checksummed | In place | server/migrations with checksum enforcement (server/src/db/migrate.ts) | Engineering |

## CC9 Risk mitigation

| Id | Control | Status | Evidence / gap | Owner |
|---|---|---|---|---|
| CC9-01 | Business continuity and disaster recovery plan with a tested restore | Not started | Backups exist (A1-02); no plan or restore test | Engineering |
| CC9-02 | Vendor contracts and DPAs on file, including no training on inputs by the AI provider (NFR-8) | Not started | | Founder |

## A1 Availability

| Id | Control | Status | Evidence / gap | Owner |
|---|---|---|---|---|
| A1-01 | Capacity scales with load | In place | docproc scales on QueueDepth (docproc.tf) | Engineering |
| A1-02 | Automated database backups, kept for a set period | In place | backup_retention_period = var.db_backup_retention_days (data.tf); Multi-AZ and deletion protection in production (envs/production/main.tf) | Engineering |
| A1-03 | Availability target measured: 99.5% monthly (Architecture §15) | Not started | No uptime measurement yet | Engineering |

## C1 Confidentiality

| Id | Control | Status | Evidence / gap | Owner |
|---|---|---|---|---|
| C1-01 | Confidential data deleted on request within the stated period, with proof | In place | Per-project deletion within 30 days and a deletion certificate (server/src/trust/TrustService.ts, routes/trust.ts); runbook 5 | Engineering |
| C1-02 | Linked files are not kept: fetched copies are discarded after processing | Partial | ADR-010 (amended); TO CONFIRM by test that no fetched copy remains after parse | Engineering |

---

## Evidence collection

For each "In place" control, collect at the start of the observation period and then on the
schedule below. Keep the date and who collected it.

| What | Controls | How | When |
|---|---|---|---|
| Terraform plan output for production with no drift | CC6-08, CC6-10, CC8-03, A1-01, A1-02 | `terraform plan` in envs/production, saved | Monthly |
| CI run history for releases | CC8-01 | Workflow run list for main | Each release |
| Migration list with checksums | CC8-04 | `schema_migrations` export | Each release |
| Audit chain verification | CC7-01 | Recompute the audit_events hash chain and record the result | Monthly |
| Deletion certificates issued and their timeliness | C1-01 | `project_deletions` where completed: requested_at, completed_at, due_by | Monthly |
| Access list for AWS and the database | CC6-06, CC6-07 | IAM user and role export | Quarterly |
| Trust pack as published | CC2-01 | The trust pack PDF for the release | Each release |

## Next steps (in order)

1. Choose the auditor and confirm scope and report type.
2. Database row-level security (F8.1), so CC6-01 does not rest on application code alone.
3. MFA and login throttling (CC6-04, CC6-05); HTTPS from CloudFront to the load balancer (CC6-09).
4. CloudTrail and GuardDuty in Terraform; dependency and image scanning in CI (CC7-03, CC7-05).
5. Write the policy set: information security, access control, incident response, vendor
   management, business continuity (CC1-01, CC6-06, CC7-06, CC3-02, CC9-01).
6. External penetration test (CC4-02), then a restore test (CC9-01).
