CREATE TABLE "product_images" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"device_id" uuid NOT NULL,
	"hlc" text NOT NULL,
	"created_at_ms" bigint NOT NULL,
	"updated_at_ms" bigint NOT NULL,
	"deleted_at_ms" bigint,
	"product_id" uuid NOT NULL,
	"mime" text NOT NULL,
	"data_base64" text NOT NULL,
	"byte_size" integer NOT NULL,
	CONSTRAINT "chk_product_images_hlc_len" CHECK (length("product_images"."hlc") = 58),
	CONSTRAINT "chk_product_images_mime" CHECK ("product_images"."mime" IN ('image/jpeg', 'image/webp', 'image/png')),
	CONSTRAINT "chk_product_images_size" CHECK ("product_images"."byte_size" > 0 AND "product_images"."byte_size" <= 160000)
);
--> statement-breakpoint
ALTER TABLE "product_images" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "product_images" ADD CONSTRAINT "product_images_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uidx_product_images_org_product" ON "product_images" USING btree ("organization_id","product_id") WHERE "product_images"."deleted_at_ms" IS NULL;--> statement-breakpoint
CREATE POLICY "product_images_tenant_isolation" ON "product_images" AS PERMISSIVE FOR ALL TO "mezon_app" USING ("organization_id" = mezon_current_organization_id()) WITH CHECK ("organization_id" = mezon_current_organization_id());--> statement-breakpoint
ALTER TABLE "product_images" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON TABLE "product_images" FROM "mezon_app";--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON TABLE "product_images" TO "mezon_app";
