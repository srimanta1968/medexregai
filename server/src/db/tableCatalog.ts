/**
 * Every table the application may query, and how it is scoped.
 *
 * DataService refuses a table that is not listed here, so a typo or an
 * attacker-influenced table name can never reach SQL (coding standard
 * "Missing Table Catalog Validation"). Add a table here in the same change as
 * the migration that creates it.
 *
 *  - platform: not owned by one firm (accounts, firms themselves, built-in roles)
 *  - tenant:   every row belongs to exactly one org via org_id; queries run with
 *              the org context set (row-level security policies arrive in F8.1)
 */
export type TableScope = 'platform' | 'tenant';

export const TABLE_CATALOG = {
  users: 'platform',
  user_profiles: 'platform',
  orgs: 'platform',
  roles: 'platform',
  refresh_tokens: 'platform',
  password_reset_tokens: 'platform',
  user_identities: 'platform',
  sso_handoffs: 'platform',
  sso_signups: 'platform',
  pilot_requests: 'platform',
  device_checks: 'platform',
  // F6.2: the opt-in directory and visitors' requests are read across firms by routing.
  firm_intro_settings: 'platform',
  intro_requests: 'platform',
  // F6.3: Stripe webhook events already handled (no firm data).
  stripe_events: 'platform',
  // Distinct product codes of firms' devices (no firm or device identity), pushed to fda-data.
  device_product_codes: 'platform',
  memberships: 'tenant',
  invites: 'tenant',
  client_workspaces: 'tenant',
  devices: 'tenant',
  projects: 'tenant',
  audit_events: 'tenant',
  ai_calls: 'tenant',
  ai_project_usage: 'tenant',
  ai_cost_alerts: 'tenant',
  firm_model_providers: 'tenant',
  files: 'tenant',
  file_versions: 'tenant',
  source_locations: 'tenant',
  chunks: 'tenant',
  citation_gate_runs: 'tenant',
  eval_runs: 'tenant',
  client_requests: 'tenant',
  client_request_items: 'tenant',
  upload_links: 'tenant',
  project_deletions: 'tenant',
  project_deletion_objects: 'tenant',
  project_inbound_addresses: 'tenant',
  inbound_emails: 'tenant',
  // F2.1 read-only folder connections (migration 023).
  folder_connections: 'tenant',
  project_folder_links: 'tenant',
  connection_oauth_states: 'tenant',
  // F2.2 eSTAR sections (FDA reference data) and each file's section (migration 025).
  estar_sections: 'platform',
  file_assignments: 'tenant',
  // F2.2 version and duplicate groups (migration 027).
  file_revision_groups: 'tenant',
  file_revision_members: 'tenant',
  // F2.3 extracted facts and problems (migration 028).
  facts: 'tenant',
  problems: 'tenant',
  // F3.1 review board: sections of a submission and their status history (migration 030).
  project_sections: 'tenant',
  section_status_events: 'tenant',
  section_drafts: 'tenant',
  draft_statements: 'tenant',
  // F3.3 revision impact (migration 032).
  statement_sources: 'tenant',
  impact_actions: 'tenant',
  // F3.4 dated records for the eQMS (migration 033).
  record_exports: 'tenant',
  // F8.1: each firm's KMS key for its S3 objects.
  org_storage_keys: 'tenant',
  // F3.5 FDA checks of K-numbers in drafts (migration 034).
  draft_fda_checks: 'tenant',
  // F3.6 firm templates and past wording (migration 035).
  firm_templates: 'tenant',
  firm_precedents: 'tenant',
  // F4.1 time capture: activity codes (migration 037, reference data) and entries (038).
  time_activities: 'platform',
  time_entries: 'tenant',
  // F4.2 pilot report: the firm's baseline and RA lead sign-offs (migration 039).
  pilot_baselines: 'tenant',
  pilot_signoffs: 'tenant',
  // F4.3 usage per client and project (migration 040).
  usage_events: 'tenant',
  usage_daily: 'tenant',
  // F5.1 FDA letters, deficiencies and what they affect (migration 042).
  fda_letters: 'tenant',
  fda_deficiencies: 'tenant',
  fda_deficiency_links: 'tenant',
  // F5.2 substantial-equivalence comparison tables (migration 043).
  // F6.3 billing (migration 048): plan and credits per firm, credit movements.
  firm_billing: 'tenant',
  credit_ledger: 'tenant',
  // F6.3 scoped API keys (migration 047); looked up by token_hash before the org is known.
  api_keys: 'tenant',
  introductions: 'tenant',
  se_comparisons: 'tenant',
  // F4.4 sign-in throttling and the authenticator-app second factor (migration 041).
  auth_attempts: 'platform',
  user_mfa: 'platform',
  platform_eval_runs: 'platform',
} as const satisfies Record<string, TableScope>;

export type CatalogTable = keyof typeof TABLE_CATALOG;

/** Narrow an arbitrary string to a catalogued table, or throw. */
export function assertCatalogTable(name: string): CatalogTable {
  if (!Object.prototype.hasOwnProperty.call(TABLE_CATALOG, name)) {
    throw new Error(`Table "${name}" is not in the table catalog (server/src/db/tableCatalog.ts).`);
  }
  return name as CatalogTable;
}

export function tableScope(table: CatalogTable): TableScope {
  return TABLE_CATALOG[table];
}
