-- Verify application role was pre-provisioned by packages/db-cloud/ops/provision-app-role.mjs
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'mezon_app') THEN
    RAISE EXCEPTION 'Required PostgreSQL role "mezon_app" does not exist. Run packages/db-cloud/ops/provision-app-role.mjs before applying migrations.'
      USING ERRCODE = '22023';
  END IF;
END
$$;
--> statement-breakpoint
GRANT USAGE ON SCHEMA public TO mezon_app;
--> statement-breakpoint
-- Fail-closed tenant context reader: returns NULL when app.organization_id is unset, empty, or invalid UUIDv7.
CREATE OR REPLACE FUNCTION mezon_current_organization_id()
RETURNS uuid
LANGUAGE sql
STABLE
AS $$
  SELECT CASE
    WHEN NULLIF(current_setting('app.organization_id', true), '') IS NULL THEN NULL
    WHEN current_setting('app.organization_id', true) ~ '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      THEN current_setting('app.organization_id', true)::uuid
    ELSE NULL
  END;
$$;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION mezon_current_organization_id() TO mezon_app;
--> statement-breakpoint
-- Drop legacy 2-argument signature if an unmerged local DB applied an earlier draft.
DROP FUNCTION IF EXISTS mezon_apply_tenant_rls(regclass, name);
--> statement-breakpoint
-- Reusable helper enforcing ENABLE + FORCE RLS + fail-closed USING/WITH CHECK + class-based DML grants for mezon_app.
-- FACT -> SELECT, INSERT (immutable).
-- ATTR / MONOTONE -> SELECT, INSERT, UPDATE (tombstone only, no physical DELETE).
-- Monotone column transitions (e.g. irreversible voided_at) will be enforced at the DB layer in later tasks.
-- Note: RLS isolates at organization_id level; store_id isolation is enforced in the application layer.
CREATE OR REPLACE FUNCTION mezon_apply_tenant_rls(
  target_table regclass,
  table_class text,
  org_col name DEFAULT 'organization_id'
)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  v_policy_name text := replace(target_table::text, '.', '_') || '_tenant_isolation';
  v_privileges text;
BEGIN
  IF table_class = 'FACT' THEN
    v_privileges := 'SELECT, INSERT';
  ELSIF table_class IN ('ATTR', 'MONOTONE') THEN
    v_privileges := 'SELECT, INSERT, UPDATE';
  ELSE
    RAISE EXCEPTION 'Invalid synced table class "%" for mezon_apply_tenant_rls (expected FACT, ATTR, or MONOTONE)', table_class
      USING ERRCODE = '22023';
  END IF;

  EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', target_table);
  EXECUTE format('ALTER TABLE %s FORCE ROW LEVEL SECURITY', target_table);
  EXECUTE format('DROP POLICY IF EXISTS %I ON %s', v_policy_name, target_table);
  EXECUTE format(
    'CREATE POLICY %I ON %s AS PERMISSIVE FOR ALL TO mezon_app USING (%I = mezon_current_organization_id()) WITH CHECK (%I = mezon_current_organization_id())',
    v_policy_name,
    target_table,
    org_col,
    org_col
  );
  EXECUTE format('REVOKE ALL ON TABLE %s FROM mezon_app', target_table);
  EXECUTE format('GRANT %s ON TABLE %s TO mezon_app', v_privileges, target_table);
END;
$$;
