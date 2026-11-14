CREATE TABLE "cloud_login_identities" (
	"id" uuid PRIMARY KEY NOT NULL,
	"created_at_ms" bigint NOT NULL,
	"updated_at_ms" bigint NOT NULL,
	"login" text NOT NULL,
	"org_id" text NOT NULL,
	"user_id" text NOT NULL,
	"password_hash" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "cloud_organizations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"created_at_ms" bigint NOT NULL,
	"updated_at_ms" bigint NOT NULL,
	"name" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL
);
--> statement-breakpoint
ALTER TABLE "cloud_organizations" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "cloud_refresh_tokens" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"created_at_ms" bigint NOT NULL,
	"updated_at_ms" bigint NOT NULL,
	"user_id" text NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at_ms" bigint NOT NULL,
	"revoked_at_ms" bigint
);
--> statement-breakpoint
ALTER TABLE "cloud_refresh_tokens" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "cloud_stores" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"created_at_ms" bigint NOT NULL,
	"updated_at_ms" bigint NOT NULL,
	"name" text NOT NULL,
	"code" text NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL
);
--> statement-breakpoint
ALTER TABLE "cloud_stores" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "cloud_users" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"created_at_ms" bigint NOT NULL,
	"updated_at_ms" bigint NOT NULL,
	"hub_user_id" text,
	"username" text NOT NULL,
	"role" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"failed_login_attempts" integer DEFAULT 0 NOT NULL,
	"locked_until_ms" bigint
);
--> statement-breakpoint
ALTER TABLE "cloud_users" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE UNIQUE INDEX "uidx_cloud_login_identities_login" ON "cloud_login_identities" USING btree ("login");--> statement-breakpoint
CREATE UNIQUE INDEX "uidx_cloud_login_identities_user" ON "cloud_login_identities" USING btree ("org_id","user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uidx_cloud_refresh_tokens_hash" ON "cloud_refresh_tokens" USING btree ("organization_id","token_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "uidx_cloud_stores_org_code" ON "cloud_stores" USING btree ("organization_id","code");--> statement-breakpoint
CREATE UNIQUE INDEX "uidx_cloud_users_org_username" ON "cloud_users" USING btree ("organization_id","username");--> statement-breakpoint
CREATE POLICY "cloud_organizations_tenant_isolation" ON "cloud_organizations" AS PERMISSIVE FOR ALL TO "mezon_app" USING ("organization_id" = mezon_current_organization_id()) WITH CHECK ("organization_id" = mezon_current_organization_id());--> statement-breakpoint
CREATE POLICY "cloud_refresh_tokens_tenant_isolation" ON "cloud_refresh_tokens" AS PERMISSIVE FOR ALL TO "mezon_app" USING ("organization_id" = mezon_current_organization_id()) WITH CHECK ("organization_id" = mezon_current_organization_id());--> statement-breakpoint
CREATE POLICY "cloud_stores_tenant_isolation" ON "cloud_stores" AS PERMISSIVE FOR ALL TO "mezon_app" USING ("organization_id" = mezon_current_organization_id()) WITH CHECK ("organization_id" = mezon_current_organization_id());--> statement-breakpoint
CREATE POLICY "cloud_users_tenant_isolation" ON "cloud_users" AS PERMISSIVE FOR ALL TO "mezon_app" USING ("organization_id" = mezon_current_organization_id()) WITH CHECK ("organization_id" = mezon_current_organization_id());--> statement-breakpoint
ALTER TABLE "cloud_organizations" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "cloud_stores" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "cloud_users" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "cloud_refresh_tokens" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON TABLE "cloud_organizations" FROM mezon_app;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON TABLE "cloud_organizations" TO mezon_app;--> statement-breakpoint
REVOKE ALL ON TABLE "cloud_stores" FROM mezon_app;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON TABLE "cloud_stores" TO mezon_app;--> statement-breakpoint
REVOKE ALL ON TABLE "cloud_users" FROM mezon_app;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON TABLE "cloud_users" TO mezon_app;--> statement-breakpoint
REVOKE ALL ON TABLE "cloud_refresh_tokens" FROM mezon_app;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON TABLE "cloud_refresh_tokens" TO mezon_app;--> statement-breakpoint
REVOKE ALL ON TABLE "cloud_login_identities" FROM mezon_app;--> statement-breakpoint
CREATE UNIQUE INDEX "uidx_cloud_login_identities_norm_login" ON "cloud_login_identities" USING btree (lower(trim("login")));--> statement-breakpoint
ALTER TABLE "cloud_login_identities" ADD CONSTRAINT "chk_cloud_login_identities_normalized" CHECK ("login" = lower(trim("login")));--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'mezon_auth_owner') THEN
    CREATE ROLE mezon_auth_owner WITH NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
  END IF;
END
$$;--> statement-breakpoint
GRANT USAGE ON SCHEMA public TO mezon_auth_owner;--> statement-breakpoint
REVOKE ALL ON TABLE "cloud_login_identities" FROM mezon_auth_owner;--> statement-breakpoint
GRANT SELECT ON TABLE "cloud_login_identities" TO mezon_auth_owner;--> statement-breakpoint
GRANT SELECT ON TABLE "cloud_users" TO mezon_auth_owner;--> statement-breakpoint
GRANT SELECT ON TABLE "cloud_organizations" TO mezon_auth_owner;--> statement-breakpoint
CREATE POLICY "cloud_users_auth_lookup" ON "cloud_users" AS PERMISSIVE FOR SELECT TO "mezon_auth_owner" USING (true);--> statement-breakpoint
CREATE POLICY "cloud_organizations_auth_lookup" ON "cloud_organizations" AS PERMISSIVE FOR SELECT TO "mezon_auth_owner" USING (true);--> statement-breakpoint
CREATE OR REPLACE FUNCTION auth_lookup_login(p_login text)
RETURNS TABLE (
  user_id text,
  organization_id text,
  password_hash text,
  user_status text,
  user_role text,
  user_name text,
  failed_login_attempts integer,
  locked_until_ms bigint
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  RETURN QUERY
  SELECT
    i.user_id::text,
    i.org_id::text AS organization_id,
    i.password_hash::text,
    u.status::text AS user_status,
    u.role::text AS user_role,
    u.username::text AS user_name,
    u.failed_login_attempts,
    u.locked_until_ms
  FROM public.cloud_login_identities i
  JOIN public.cloud_users u ON u.id::text = i.user_id AND u.organization_id::text = i.org_id
  JOIN public.cloud_organizations o ON o.id::text = i.org_id
  WHERE i.login = lower(trim(p_login))
    AND o.status = 'active';
END;
$$;--> statement-breakpoint
ALTER FUNCTION auth_lookup_login(text) OWNER TO mezon_auth_owner;--> statement-breakpoint
REVOKE ALL ON FUNCTION auth_lookup_login(text) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION auth_lookup_login(text) TO mezon_app;
