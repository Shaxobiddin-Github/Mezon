CREATE TABLE "cloud_licences" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"created_at_ms" bigint NOT NULL,
	"updated_at_ms" bigint NOT NULL,
	"licence_id" text NOT NULL,
	"plan" text NOT NULL,
	"envelope_json" text NOT NULL,
	"valid_from_ms" bigint NOT NULL,
	"valid_until_ms" bigint NOT NULL,
	"revoked_at_ms" bigint,
	CONSTRAINT "chk_cloud_licences_plan" CHECK ("cloud_licences"."plan" IN ('start', 'business', 'pro')),
	CONSTRAINT "chk_cloud_licences_range" CHECK ("cloud_licences"."valid_until_ms" > "cloud_licences"."valid_from_ms")
);
--> statement-breakpoint
ALTER TABLE "cloud_licences" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "cloud_platform_invoices" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"created_at_ms" bigint NOT NULL,
	"updated_at_ms" bigint NOT NULL,
	"period" text NOT NULL,
	"plan" text NOT NULL,
	"amount_tiyin" bigint NOT NULL,
	"status" text NOT NULL,
	"paid_at_ms" bigint,
	CONSTRAINT "chk_cloud_platform_invoices_period" CHECK ("cloud_platform_invoices"."period" ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
	CONSTRAINT "chk_cloud_platform_invoices_plan" CHECK ("cloud_platform_invoices"."plan" IN ('start', 'business', 'pro')),
	CONSTRAINT "chk_cloud_platform_invoices_amount" CHECK ("cloud_platform_invoices"."amount_tiyin" >= 0),
	CONSTRAINT "chk_cloud_platform_invoices_status" CHECK ("cloud_platform_invoices"."status" IN ('issued', 'paid', 'void')),
	CONSTRAINT "chk_cloud_platform_invoices_paid" CHECK (("cloud_platform_invoices"."status" = 'paid') = ("cloud_platform_invoices"."paid_at_ms" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "cloud_platform_invoices" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE UNIQUE INDEX "uidx_cloud_licences_licence" ON "cloud_licences" USING btree ("organization_id","licence_id");--> statement-breakpoint
CREATE INDEX "idx_cloud_licences_org_until" ON "cloud_licences" USING btree ("organization_id","valid_until_ms");--> statement-breakpoint
CREATE UNIQUE INDEX "uidx_cloud_platform_invoices_period" ON "cloud_platform_invoices" USING btree ("organization_id","period");--> statement-breakpoint
CREATE POLICY "cloud_licences_tenant_isolation" ON "cloud_licences" AS PERMISSIVE FOR ALL TO "mezon_app" USING ("organization_id" = mezon_current_organization_id()) WITH CHECK ("organization_id" = mezon_current_organization_id());--> statement-breakpoint
CREATE POLICY "cloud_platform_invoices_tenant_isolation" ON "cloud_platform_invoices" AS PERMISSIVE FOR ALL TO "mezon_app" USING ("organization_id" = mezon_current_organization_id()) WITH CHECK ("organization_id" = mezon_current_organization_id());--> statement-breakpoint
ALTER TABLE "cloud_licences" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "cloud_licences" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "cloud_licences_tenant_isolation" ON "cloud_licences";--> statement-breakpoint
CREATE POLICY "cloud_licences_tenant_isolation" ON "cloud_licences" AS PERMISSIVE FOR ALL TO "mezon_app" USING ("organization_id" = mezon_current_organization_id()) WITH CHECK ("organization_id" = mezon_current_organization_id());--> statement-breakpoint
REVOKE ALL ON TABLE "cloud_licences" FROM "mezon_app";--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON TABLE "cloud_licences" TO "mezon_app";--> statement-breakpoint
ALTER TABLE "cloud_platform_invoices" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "cloud_platform_invoices" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "cloud_platform_invoices_tenant_isolation" ON "cloud_platform_invoices";--> statement-breakpoint
CREATE POLICY "cloud_platform_invoices_tenant_isolation" ON "cloud_platform_invoices" AS PERMISSIVE FOR ALL TO "mezon_app" USING ("organization_id" = mezon_current_organization_id()) WITH CHECK ("organization_id" = mezon_current_organization_id());--> statement-breakpoint
REVOKE ALL ON TABLE "cloud_platform_invoices" FROM "mezon_app";--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON TABLE "cloud_platform_invoices" TO "mezon_app";
