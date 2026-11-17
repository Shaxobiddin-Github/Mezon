CREATE TABLE "cloud_telegram_deliveries" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"created_at_ms" bigint NOT NULL,
	"updated_at_ms" bigint NOT NULL,
	"link_id" text NOT NULL,
	"kind" text NOT NULL,
	"period_key" text NOT NULL,
	"status" text NOT NULL,
	"last_error" text,
	CONSTRAINT "chk_cloud_telegram_deliveries_kind" CHECK ("cloud_telegram_deliveries"."kind" IN ('digest', 'debt_reminder')),
	CONSTRAINT "chk_cloud_telegram_deliveries_status" CHECK ("cloud_telegram_deliveries"."status" IN ('claimed', 'sent', 'failed'))
);
--> statement-breakpoint
ALTER TABLE "cloud_telegram_deliveries" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "cloud_telegram_link_codes" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"created_at_ms" bigint NOT NULL,
	"updated_at_ms" bigint NOT NULL,
	"kind" text NOT NULL,
	"user_id" text,
	"customer_id" text,
	"code_hash" text NOT NULL,
	"expires_at_ms" bigint NOT NULL,
	"used_at_ms" bigint,
	CONSTRAINT "chk_cloud_telegram_link_codes_kind" CHECK ("cloud_telegram_link_codes"."kind" IN ('staff', 'customer')),
	CONSTRAINT "chk_cloud_telegram_link_codes_target" CHECK (("cloud_telegram_link_codes"."kind" = 'staff' AND "cloud_telegram_link_codes"."user_id" IS NOT NULL AND "cloud_telegram_link_codes"."customer_id" IS NULL) OR ("cloud_telegram_link_codes"."kind" = 'customer' AND "cloud_telegram_link_codes"."customer_id" IS NOT NULL AND "cloud_telegram_link_codes"."user_id" IS NULL))
);
--> statement-breakpoint
ALTER TABLE "cloud_telegram_link_codes" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "cloud_telegram_links" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"created_at_ms" bigint NOT NULL,
	"updated_at_ms" bigint NOT NULL,
	"kind" text NOT NULL,
	"user_id" text,
	"customer_id" text,
	"chat_id" text NOT NULL,
	"locale" text DEFAULT 'uz-Latn' NOT NULL,
	"consent_at_ms" bigint,
	"revoked_at_ms" bigint,
	CONSTRAINT "chk_cloud_telegram_links_kind" CHECK ("cloud_telegram_links"."kind" IN ('staff', 'customer')),
	CONSTRAINT "chk_cloud_telegram_links_target" CHECK (("cloud_telegram_links"."kind" = 'staff' AND "cloud_telegram_links"."user_id" IS NOT NULL AND "cloud_telegram_links"."customer_id" IS NULL) OR ("cloud_telegram_links"."kind" = 'customer' AND "cloud_telegram_links"."customer_id" IS NOT NULL AND "cloud_telegram_links"."user_id" IS NULL)),
	CONSTRAINT "chk_cloud_telegram_links_locale" CHECK ("cloud_telegram_links"."locale" IN ('uz-Latn', 'uz-Cyrl', 'ru')),
	CONSTRAINT "chk_cloud_telegram_links_chat" CHECK ("cloud_telegram_links"."chat_id" ~ '^-?[0-9]{1,20}$')
);
--> statement-breakpoint
ALTER TABLE "cloud_telegram_links" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE UNIQUE INDEX "uidx_cloud_telegram_deliveries_once" ON "cloud_telegram_deliveries" USING btree ("organization_id","link_id","kind","period_key");--> statement-breakpoint
CREATE UNIQUE INDEX "uidx_cloud_telegram_link_codes_hash" ON "cloud_telegram_link_codes" USING btree ("organization_id","code_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "uidx_cloud_telegram_links_staff_active" ON "cloud_telegram_links" USING btree ("organization_id","user_id") WHERE "cloud_telegram_links"."kind" = 'staff' AND "cloud_telegram_links"."revoked_at_ms" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "uidx_cloud_telegram_links_customer_active" ON "cloud_telegram_links" USING btree ("organization_id","customer_id") WHERE "cloud_telegram_links"."kind" = 'customer' AND "cloud_telegram_links"."revoked_at_ms" IS NULL;--> statement-breakpoint
CREATE INDEX "idx_cloud_telegram_links_chat" ON "cloud_telegram_links" USING btree ("chat_id");--> statement-breakpoint
CREATE POLICY "cloud_telegram_deliveries_tenant_isolation" ON "cloud_telegram_deliveries" AS PERMISSIVE FOR ALL TO "mezon_app" USING ("organization_id" = mezon_current_organization_id()) WITH CHECK ("organization_id" = mezon_current_organization_id());--> statement-breakpoint
CREATE POLICY "cloud_telegram_link_codes_tenant_isolation" ON "cloud_telegram_link_codes" AS PERMISSIVE FOR ALL TO "mezon_app" USING ("organization_id" = mezon_current_organization_id()) WITH CHECK ("organization_id" = mezon_current_organization_id());--> statement-breakpoint
CREATE POLICY "cloud_telegram_links_tenant_isolation" ON "cloud_telegram_links" AS PERMISSIVE FOR ALL TO "mezon_app" USING ("organization_id" = mezon_current_organization_id()) WITH CHECK ("organization_id" = mezon_current_organization_id());--> statement-breakpoint
ALTER TABLE "cloud_telegram_link_codes" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "cloud_telegram_link_codes" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "cloud_telegram_link_codes_tenant_isolation" ON "cloud_telegram_link_codes";--> statement-breakpoint
CREATE POLICY "cloud_telegram_link_codes_tenant_isolation" ON "cloud_telegram_link_codes" AS PERMISSIVE FOR ALL TO "mezon_app" USING ("organization_id" = mezon_current_organization_id()) WITH CHECK ("organization_id" = mezon_current_organization_id());--> statement-breakpoint
REVOKE ALL ON TABLE "cloud_telegram_link_codes" FROM "mezon_app";--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON TABLE "cloud_telegram_link_codes" TO "mezon_app";--> statement-breakpoint
ALTER TABLE "cloud_telegram_links" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "cloud_telegram_links" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "cloud_telegram_links_tenant_isolation" ON "cloud_telegram_links";--> statement-breakpoint
CREATE POLICY "cloud_telegram_links_tenant_isolation" ON "cloud_telegram_links" AS PERMISSIVE FOR ALL TO "mezon_app" USING ("organization_id" = mezon_current_organization_id()) WITH CHECK ("organization_id" = mezon_current_organization_id());--> statement-breakpoint
REVOKE ALL ON TABLE "cloud_telegram_links" FROM "mezon_app";--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON TABLE "cloud_telegram_links" TO "mezon_app";--> statement-breakpoint
ALTER TABLE "cloud_telegram_deliveries" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "cloud_telegram_deliveries" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "cloud_telegram_deliveries_tenant_isolation" ON "cloud_telegram_deliveries";--> statement-breakpoint
CREATE POLICY "cloud_telegram_deliveries_tenant_isolation" ON "cloud_telegram_deliveries" AS PERMISSIVE FOR ALL TO "mezon_app" USING ("organization_id" = mezon_current_organization_id()) WITH CHECK ("organization_id" = mezon_current_organization_id());--> statement-breakpoint
REVOKE ALL ON TABLE "cloud_telegram_deliveries" FROM "mezon_app";--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON TABLE "cloud_telegram_deliveries" TO "mezon_app";--> statement-breakpoint
GRANT SELECT ON TABLE "cloud_telegram_links" TO mezon_auth_owner;--> statement-breakpoint
CREATE POLICY "cloud_telegram_links_chat_lookup" ON "cloud_telegram_links" AS PERMISSIVE FOR SELECT TO "mezon_auth_owner" USING (true);--> statement-breakpoint
CREATE OR REPLACE FUNCTION telegram_orgs_for_chat(p_chat_id text)
RETURNS TABLE (organization_id text)
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT DISTINCT l.organization_id::text
    FROM cloud_telegram_links l
   WHERE l.chat_id = p_chat_id AND l.revoked_at_ms IS NULL
$$;--> statement-breakpoint
ALTER FUNCTION telegram_orgs_for_chat(text) OWNER TO mezon_auth_owner;--> statement-breakpoint
REVOKE ALL ON FUNCTION telegram_orgs_for_chat(text) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION telegram_orgs_for_chat(text) TO mezon_app;--> statement-breakpoint
CREATE OR REPLACE FUNCTION telegram_active_orgs()
RETURNS TABLE (organization_id text)
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT DISTINCT l.organization_id::text
    FROM cloud_telegram_links l
   WHERE l.revoked_at_ms IS NULL
$$;--> statement-breakpoint
ALTER FUNCTION telegram_active_orgs() OWNER TO mezon_auth_owner;--> statement-breakpoint
REVOKE ALL ON FUNCTION telegram_active_orgs() FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION telegram_active_orgs() TO mezon_app;
