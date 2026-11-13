-- F8.1 row-level security on every tenant table (tableCatalog 'tenant'): the database itself
-- refuses rows of another firm. DataService sets app.org_id per transaction; a row is visible and
-- writable only when its org_id equals it. The one exception is a token lookup before the firm is
-- known (invite, SSO, upload link, API key, connection state, inbound address): DataService sets
-- app.rls_token_lookup = 'on' for that single statement only (DataService.lookupByToken).
--
-- FORCE applies the policies to the table owner too. Roles with BYPASSRLS (superusers) still skip
-- them, so the app must connect as a non-superuser role: this migration creates medexregai_app
-- (NOLOGIN; give it LOGIN and a password per environment, see docs/ops/runbooks.md) with
-- read/write on the tables. Migrations keep running as the owner (DB_MIGRATION_USER).

DO $$
DECLARE
  t text;
  tenant_tables text[] := ARRAY[
    'memberships',
    'invites',
    'client_workspaces',
    'devices',
    'projects',
    'audit_events',
    'ai_calls',
    'ai_project_usage',
    'ai_cost_alerts',
    'firm_model_providers',
    'files',
    'file_versions',
    'source_locations',
    'chunks',
    'citation_gate_runs',
    'eval_runs',
    'client_requests',
    'client_request_items',
    'upload_links',
    'project_deletions',
    'project_deletion_objects',
    'project_inbound_addresses',
    'inbound_emails',
    'folder_connections',
    'project_folder_links',
    'connection_oauth_states',
    'file_assignments',
    'file_revision_groups',
    'file_revision_members',
    'facts',
    'problems',
    'project_sections',
    'section_status_events',
    'section_drafts',
    'draft_statements',
    'statement_sources',
    'impact_actions',
    'record_exports',
    'draft_fda_checks',
    'firm_templates',
    'firm_precedents',
    'time_entries',
    'pilot_baselines',
    'pilot_signoffs',
    'usage_events',
    'usage_daily',
    'fda_letters',
    'fda_deficiencies',
    'fda_deficiency_links',
    'firm_billing',
    'credit_ledger',
    'api_keys',
    'introductions',
    'se_comparisons'
  ];
BEGIN
  FOREACH t IN ARRAY tenant_tables LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I
         USING (org_id = nullif(current_setting(''app.org_id'', true), '''')::uuid
                OR current_setting(''app.rls_token_lookup'', true) = ''on'')
         WITH CHECK (org_id = nullif(current_setting(''app.org_id'', true), '''')::uuid)', t);
  END LOOP;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'medexregai_app') THEN
    CREATE ROLE medexregai_app NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
  END IF;
END $$;
GRANT USAGE ON SCHEMA public TO medexregai_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO medexregai_app;
GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO medexregai_app;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO medexregai_app;
-- Tables and sequences created by later migrations (run by the owner) are granted too.
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO medexregai_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO medexregai_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO medexregai_app;
