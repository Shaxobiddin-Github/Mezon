CREATE TABLE "cloud_device_pairing_codes" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"created_at_ms" bigint NOT NULL,
	"updated_at_ms" bigint NOT NULL,
	"store_id" text NOT NULL,
	"device_name" text NOT NULL,
	"code_hash" text NOT NULL,
	"attempts_left" integer DEFAULT 5 NOT NULL,
	"expires_at_ms" bigint NOT NULL,
	"used_at_ms" bigint
);
--> statement-breakpoint
ALTER TABLE "cloud_device_pairing_codes" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "cloud_device_tokens" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"created_at_ms" bigint NOT NULL,
	"updated_at_ms" bigint NOT NULL,
	"device_id" text NOT NULL,
	"token_hash" text NOT NULL,
	"client_request_id" text,
	"expires_at_ms" bigint NOT NULL,
	"revoked_at_ms" bigint,
	"grace_until_ms" bigint,
	"replaced_by_token_id" text
);
--> statement-breakpoint
ALTER TABLE "cloud_device_tokens" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "cloud_devices" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"created_at_ms" bigint NOT NULL,
	"updated_at_ms" bigint NOT NULL,
	"store_id" text NOT NULL,
	"device_id" text NOT NULL,
	"name" text NOT NULL,
	"platform" text NOT NULL,
	"app_version" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"last_seen_at_ms" bigint NOT NULL
);
--> statement-breakpoint
ALTER TABLE "cloud_devices" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE UNIQUE INDEX "uidx_cloud_device_pairing_codes_hash" ON "cloud_device_pairing_codes" USING btree ("code_hash");--> statement-breakpoint
CREATE INDEX "idx_cloud_device_pairing_codes_org_store" ON "cloud_device_pairing_codes" USING btree ("organization_id","store_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uidx_cloud_device_tokens_hash" ON "cloud_device_tokens" USING btree ("organization_id","token_hash");--> statement-breakpoint
CREATE INDEX "idx_cloud_device_tokens_client_req" ON "cloud_device_tokens" USING btree ("organization_id","client_request_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uidx_cloud_devices_org_device" ON "cloud_devices" USING btree ("organization_id","device_id");--> statement-breakpoint
CREATE INDEX "idx_cloud_devices_device_id" ON "cloud_devices" USING btree ("device_id");--> statement-breakpoint
CREATE POLICY "cloud_device_pairing_codes_tenant_isolation" ON "cloud_device_pairing_codes" AS PERMISSIVE FOR ALL TO "mezon_app" USING ("organization_id" = mezon_current_organization_id()) WITH CHECK ("organization_id" = mezon_current_organization_id());--> statement-breakpoint
CREATE POLICY "cloud_device_tokens_tenant_isolation" ON "cloud_device_tokens" AS PERMISSIVE FOR ALL TO "mezon_app" USING ("organization_id" = mezon_current_organization_id()) WITH CHECK ("organization_id" = mezon_current_organization_id());--> statement-breakpoint
CREATE POLICY "cloud_devices_tenant_isolation" ON "cloud_devices" AS PERMISSIVE FOR ALL TO "mezon_app" USING ("organization_id" = mezon_current_organization_id()) WITH CHECK ("organization_id" = mezon_current_organization_id());--> statement-breakpoint
ALTER TABLE "cloud_device_pairing_codes" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "cloud_device_tokens" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "cloud_devices" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON TABLE "cloud_device_pairing_codes" FROM mezon_app;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON TABLE "cloud_device_pairing_codes" TO mezon_app;--> statement-breakpoint
REVOKE ALL ON TABLE "cloud_device_tokens" FROM mezon_app;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON TABLE "cloud_device_tokens" TO mezon_app;--> statement-breakpoint
REVOKE ALL ON TABLE "cloud_devices" FROM mezon_app;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON TABLE "cloud_devices" TO mezon_app;--> statement-breakpoint
GRANT SELECT ON TABLE "cloud_device_pairing_codes" TO mezon_auth_owner;--> statement-breakpoint
GRANT SELECT ON TABLE "cloud_devices" TO mezon_auth_owner;--> statement-breakpoint
CREATE POLICY "cloud_device_pairing_codes_auth_owner" ON "cloud_device_pairing_codes" AS PERMISSIVE FOR SELECT TO "mezon_auth_owner" USING (true);--> statement-breakpoint
CREATE POLICY "cloud_devices_auth_owner" ON "cloud_devices" AS PERMISSIVE FOR SELECT TO "mezon_auth_owner" USING (true);--> statement-breakpoint
CREATE OR REPLACE FUNCTION auth_lookup_pairing_code(p_code_hash text)
RETURNS TABLE (
  pairing_code_id uuid,
  organization_id uuid,
  store_id text,
  device_name text,
  attempts_left integer,
  expires_at_ms bigint,
  used_at_ms bigint
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  RETURN QUERY
  SELECT
    p.id AS pairing_code_id,
    p.organization_id,
    p.store_id,
    p.device_name,
    p.attempts_left,
    p.expires_at_ms,
    p.used_at_ms
  FROM public.cloud_device_pairing_codes p
  WHERE p.code_hash = p_code_hash;
END;
$$;--> statement-breakpoint
ALTER FUNCTION auth_lookup_pairing_code(text) OWNER TO mezon_auth_owner;--> statement-breakpoint
REVOKE ALL ON FUNCTION auth_lookup_pairing_code(text) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION auth_lookup_pairing_code(text) TO mezon_app;--> statement-breakpoint
CREATE OR REPLACE FUNCTION auth_lookup_device_owner(p_device_id text)
RETURNS TABLE (
  organization_id uuid,
  device_status text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  RETURN QUERY
  SELECT d.organization_id, d.status
  FROM public.cloud_devices d
  WHERE d.device_id = p_device_id
  LIMIT 1;
END;
$$;--> statement-breakpoint
ALTER FUNCTION auth_lookup_device_owner(text) OWNER TO mezon_auth_owner;--> statement-breakpoint
REVOKE ALL ON FUNCTION auth_lookup_device_owner(text) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION auth_lookup_device_owner(text) TO mezon_app;