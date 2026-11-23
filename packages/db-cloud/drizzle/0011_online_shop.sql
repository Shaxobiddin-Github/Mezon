CREATE TABLE "cloud_shop_order_lines" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"created_at_ms" bigint NOT NULL,
	"updated_at_ms" bigint NOT NULL,
	"order_id" text NOT NULL,
	"product_id" text NOT NULL,
	"name" text NOT NULL,
	"unit" text NOT NULL,
	"qty_milli" bigint NOT NULL,
	"price_tiyin" bigint NOT NULL,
	"total_tiyin" bigint NOT NULL,
	CONSTRAINT "chk_cloud_shop_order_lines_qty" CHECK ("cloud_shop_order_lines"."qty_milli" > 0),
	CONSTRAINT "chk_cloud_shop_order_lines_money" CHECK ("cloud_shop_order_lines"."price_tiyin" >= 0 AND "cloud_shop_order_lines"."total_tiyin" >= 0)
);
--> statement-breakpoint
ALTER TABLE "cloud_shop_order_lines" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "cloud_shop_orders" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"created_at_ms" bigint NOT NULL,
	"updated_at_ms" bigint NOT NULL,
	"shop_id" text NOT NULL,
	"store_id" text NOT NULL,
	"order_no" integer NOT NULL,
	"customer_name" text NOT NULL,
	"customer_phone" text NOT NULL,
	"fulfilment" text NOT NULL,
	"address" text,
	"note" text,
	"status" text NOT NULL,
	"total_tiyin" bigint NOT NULL,
	"access_token_hash" text NOT NULL,
	CONSTRAINT "chk_cloud_shop_orders_fulfilment" CHECK ("cloud_shop_orders"."fulfilment" IN ('pickup', 'delivery')),
	CONSTRAINT "chk_cloud_shop_orders_status" CHECK ("cloud_shop_orders"."status" IN ('new', 'accepted', 'ready', 'done', 'cancelled')),
	CONSTRAINT "chk_cloud_shop_orders_total" CHECK ("cloud_shop_orders"."total_tiyin" >= 0),
	CONSTRAINT "chk_cloud_shop_orders_phone" CHECK ("cloud_shop_orders"."customer_phone" ~ '^\+?[0-9]{9,15}$')
);
--> statement-breakpoint
ALTER TABLE "cloud_shop_orders" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "cloud_shop_products" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"created_at_ms" bigint NOT NULL,
	"updated_at_ms" bigint NOT NULL,
	"product_id" text NOT NULL,
	"is_published" boolean DEFAULT true NOT NULL
);
--> statement-breakpoint
ALTER TABLE "cloud_shop_products" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "cloud_shops" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"created_at_ms" bigint NOT NULL,
	"updated_at_ms" bigint NOT NULL,
	"store_id" text NOT NULL,
	"slug" text NOT NULL,
	"title" text NOT NULL,
	"phone" text,
	"address" text,
	"about" text,
	"is_enabled" boolean DEFAULT false NOT NULL,
	"next_order_no" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "chk_cloud_shops_slug" CHECK ("cloud_shops"."slug" ~ '^[a-z0-9][a-z0-9-]{2,39}$'),
	CONSTRAINT "chk_cloud_shops_title" CHECK (length(trim("cloud_shops"."title")) BETWEEN 1 AND 80),
	CONSTRAINT "chk_cloud_shops_next_no" CHECK ("cloud_shops"."next_order_no" >= 1)
);
--> statement-breakpoint
ALTER TABLE "cloud_shops" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE INDEX "idx_cloud_shop_order_lines_order" ON "cloud_shop_order_lines" USING btree ("organization_id","order_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uidx_cloud_shop_orders_no" ON "cloud_shop_orders" USING btree ("organization_id","shop_id","order_no");--> statement-breakpoint
CREATE INDEX "idx_cloud_shop_orders_status" ON "cloud_shop_orders" USING btree ("organization_id","status","created_at_ms");--> statement-breakpoint
CREATE UNIQUE INDEX "uidx_cloud_shop_products_product" ON "cloud_shop_products" USING btree ("organization_id","product_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uidx_cloud_shops_slug" ON "cloud_shops" USING btree ("slug");--> statement-breakpoint
CREATE UNIQUE INDEX "uidx_cloud_shops_store" ON "cloud_shops" USING btree ("organization_id","store_id");--> statement-breakpoint
CREATE POLICY "cloud_shop_order_lines_tenant_isolation" ON "cloud_shop_order_lines" AS PERMISSIVE FOR ALL TO "mezon_app" USING ("organization_id" = mezon_current_organization_id()) WITH CHECK ("organization_id" = mezon_current_organization_id());--> statement-breakpoint
CREATE POLICY "cloud_shop_orders_tenant_isolation" ON "cloud_shop_orders" AS PERMISSIVE FOR ALL TO "mezon_app" USING ("organization_id" = mezon_current_organization_id()) WITH CHECK ("organization_id" = mezon_current_organization_id());--> statement-breakpoint
CREATE POLICY "cloud_shop_products_tenant_isolation" ON "cloud_shop_products" AS PERMISSIVE FOR ALL TO "mezon_app" USING ("organization_id" = mezon_current_organization_id()) WITH CHECK ("organization_id" = mezon_current_organization_id());--> statement-breakpoint
CREATE POLICY "cloud_shops_tenant_isolation" ON "cloud_shops" AS PERMISSIVE FOR ALL TO "mezon_app" USING ("organization_id" = mezon_current_organization_id()) WITH CHECK ("organization_id" = mezon_current_organization_id());--> statement-breakpoint
ALTER TABLE "cloud_shops" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON TABLE "cloud_shops" FROM "mezon_app";--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON TABLE "cloud_shops" TO "mezon_app";--> statement-breakpoint
ALTER TABLE "cloud_shop_products" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON TABLE "cloud_shop_products" FROM "mezon_app";--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON TABLE "cloud_shop_products" TO "mezon_app";--> statement-breakpoint
ALTER TABLE "cloud_shop_orders" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON TABLE "cloud_shop_orders" FROM "mezon_app";--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON TABLE "cloud_shop_orders" TO "mezon_app";--> statement-breakpoint
ALTER TABLE "cloud_shop_order_lines" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON TABLE "cloud_shop_order_lines" FROM "mezon_app";--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON TABLE "cloud_shop_order_lines" TO "mezon_app";--> statement-breakpoint
GRANT SELECT ON TABLE "cloud_shops" TO mezon_auth_owner;--> statement-breakpoint
CREATE POLICY "cloud_shops_slug_lookup" ON "cloud_shops" AS PERMISSIVE FOR SELECT TO "mezon_auth_owner" USING (true);--> statement-breakpoint
CREATE OR REPLACE FUNCTION shop_lookup_slug(p_slug text)
RETURNS TABLE (organization_id text, store_id text, shop_id text)
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT s.organization_id::text, s.store_id, s.id::text
    FROM cloud_shops s
    JOIN cloud_organizations o ON o.id = s.organization_id
   WHERE s.slug = p_slug AND s.is_enabled AND o.status = 'active'
$$;--> statement-breakpoint
ALTER FUNCTION shop_lookup_slug(text) OWNER TO mezon_auth_owner;--> statement-breakpoint
REVOKE ALL ON FUNCTION shop_lookup_slug(text) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION shop_lookup_slug(text) TO mezon_app;
