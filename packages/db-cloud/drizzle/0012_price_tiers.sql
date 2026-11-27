CREATE TABLE "product_price_tiers" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"device_id" uuid NOT NULL,
	"hlc" text NOT NULL,
	"created_at_ms" bigint NOT NULL,
	"updated_at_ms" bigint NOT NULL,
	"deleted_at_ms" bigint,
	"product_id" uuid NOT NULL,
	"min_qty" bigint NOT NULL,
	"unit_price" bigint NOT NULL,
	CONSTRAINT "chk_product_price_tiers_hlc_len" CHECK (length("product_price_tiers"."hlc") = 58),
	CONSTRAINT "chk_product_price_tiers_min_qty_pos" CHECK ("product_price_tiers"."min_qty" > 0),
	CONSTRAINT "chk_product_price_tiers_price_nonneg" CHECK ("product_price_tiers"."unit_price" >= 0)
);
--> statement-breakpoint
ALTER TABLE "product_price_tiers" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "product_price_tiers" ADD CONSTRAINT "product_price_tiers_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uidx_product_price_tiers_org_product_min" ON "product_price_tiers" USING btree ("organization_id","product_id","min_qty") WHERE "product_price_tiers"."deleted_at_ms" IS NULL;--> statement-breakpoint
CREATE POLICY "product_price_tiers_tenant_isolation" ON "product_price_tiers" AS PERMISSIVE FOR ALL TO "mezon_app" USING ("organization_id" = mezon_current_organization_id()) WITH CHECK ("organization_id" = mezon_current_organization_id());--> statement-breakpoint
ALTER TABLE "product_price_tiers" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON TABLE "product_price_tiers" FROM "mezon_app";--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON TABLE "product_price_tiers" TO "mezon_app";
