CREATE TABLE "organization_tax_profiles" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"device_id" uuid NOT NULL,
	"hlc" text NOT NULL,
	"created_at_ms" bigint NOT NULL,
	"updated_at_ms" bigint NOT NULL,
	"deleted_at_ms" bigint,
	"tin" text NOT NULL,
	"legal_name" text NOT NULL,
	"legal_address" text NOT NULL,
	"is_vat_payer" boolean NOT NULL,
	"default_vat_rate_bp" integer DEFAULT 0 NOT NULL,
	"updated_by_user_id" uuid NOT NULL,
	CONSTRAINT "chk_organization_tax_profiles_hlc_len" CHECK (length("organization_tax_profiles"."hlc") = 58),
	CONSTRAINT "chk_org_tax_profiles_id_is_org" CHECK ("organization_tax_profiles"."id" = "organization_tax_profiles"."organization_id"),
	CONSTRAINT "chk_org_tax_profiles_tin" CHECK (length("organization_tax_profiles"."tin") = 9 AND "organization_tax_profiles"."tin" ~ '^[0-9]{9}$'),
	CONSTRAINT "chk_org_tax_profiles_legal_name" CHECK (length(trim("organization_tax_profiles"."legal_name")) >= 1),
	CONSTRAINT "chk_org_tax_profiles_legal_address" CHECK (length(trim("organization_tax_profiles"."legal_address")) >= 1),
	CONSTRAINT "chk_org_tax_profiles_default_vat" CHECK ("organization_tax_profiles"."default_vat_rate_bp" >= 0 AND "organization_tax_profiles"."default_vat_rate_bp" <= 10000)
);
--> statement-breakpoint
ALTER TABLE "organization_tax_profiles" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "organization_tax_profiles" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "organization_tax_profiles" ADD CONSTRAINT "organization_tax_profiles_updated_by_user_id_users_id_fk" FOREIGN KEY ("updated_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uidx_org_tax_profiles_org" ON "organization_tax_profiles" USING btree ("organization_id") WHERE "organization_tax_profiles"."deleted_at_ms" IS NULL;--> statement-breakpoint
DROP POLICY IF EXISTS "organization_tax_profiles_tenant_isolation" ON "organization_tax_profiles";--> statement-breakpoint
CREATE POLICY "organization_tax_profiles_tenant_isolation" ON "organization_tax_profiles" AS PERMISSIVE FOR ALL TO "mezon_app" USING ("organization_id" = mezon_current_organization_id()) WITH CHECK ("organization_id" = mezon_current_organization_id());--> statement-breakpoint
REVOKE ALL ON TABLE "organization_tax_profiles" FROM "mezon_app";--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON TABLE "organization_tax_profiles" TO "mezon_app";
