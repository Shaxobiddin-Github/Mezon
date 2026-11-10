CREATE TABLE `local_cart_lines` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`store_id` text NOT NULL,
	`created_at_ms` integer NOT NULL,
	`updated_at_ms` integer NOT NULL,
	`cart_id` text NOT NULL,
	`sort_order` integer NOT NULL,
	`line_kind` text NOT NULL,
	`product_id` text,
	`variant_id` text,
	`category_id_snapshot` text,
	`item_name` text NOT NULL,
	`unit` text NOT NULL,
	`qty` integer NOT NULL,
	`unit_price_snapshot` integer NOT NULL,
	`mxik_snapshot` text,
	`package_code_snapshot` text,
	`vat_rate_bp_snapshot` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`cart_id`) REFERENCES `local_carts`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`product_id`) REFERENCES `products`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`variant_id`) REFERENCES `product_variants`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "chk_local_cart_lines_created_at_ms_int" CHECK(typeof("local_cart_lines"."created_at_ms") = 'integer'),
	CONSTRAINT "chk_local_cart_lines_updated_at_ms_int" CHECK(typeof("local_cart_lines"."updated_at_ms") = 'integer'),
	CONSTRAINT "chk_local_cart_lines_qty_int" CHECK(typeof("local_cart_lines"."qty") = 'integer'),
	CONSTRAINT "chk_local_cart_lines_unit_price_snapshot_int" CHECK(typeof("local_cart_lines"."unit_price_snapshot") = 'integer'),
	CONSTRAINT "chk_local_cart_lines_sort_nonneg" CHECK("local_cart_lines"."sort_order" >= 0),
	CONSTRAINT "chk_local_cart_lines_kind" CHECK("local_cart_lines"."line_kind" IN ('catalog', 'quick_sale')),
	CONSTRAINT "chk_local_cart_lines_kind_product" CHECK(("local_cart_lines"."line_kind" = 'catalog' AND "local_cart_lines"."product_id" IS NOT NULL) OR ("local_cart_lines"."line_kind" = 'quick_sale' AND "local_cart_lines"."product_id" IS NULL AND "local_cart_lines"."variant_id" IS NULL)),
	CONSTRAINT "chk_local_cart_lines_name_nonempty" CHECK(length(trim("local_cart_lines"."item_name")) >= 1),
	CONSTRAINT "chk_local_cart_lines_unit" CHECK("local_cart_lines"."unit" IN ('dona', 'kg', 'g', 'litr', 'metr', 'm2', 'qadoq')),
	CONSTRAINT "chk_local_cart_lines_qty_pos" CHECK("local_cart_lines"."qty" > 0),
	CONSTRAINT "chk_local_cart_lines_unit_int" CHECK("local_cart_lines"."unit" NOT IN ('dona', 'qadoq') OR ("local_cart_lines"."qty" % 1000) = 0),
	CONSTRAINT "chk_local_cart_lines_price_nonneg" CHECK("local_cart_lines"."unit_price_snapshot" >= 0),
	CONSTRAINT "chk_local_cart_lines_vat_bp" CHECK("local_cart_lines"."vat_rate_bp_snapshot" >= 0 AND "local_cart_lines"."vat_rate_bp_snapshot" <= 10000)
);
--> statement-breakpoint
CREATE INDEX `idx_local_cart_lines_cart_sort` ON `local_cart_lines` (`cart_id`,`sort_order`,`id`);--> statement-breakpoint
CREATE TABLE `local_carts` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`store_id` text NOT NULL,
	`created_at_ms` integer NOT NULL,
	`updated_at_ms` integer NOT NULL,
	`cashier_user_id` text NOT NULL,
	`status` text NOT NULL,
	`park_label` text,
	`parked_at_ms` integer,
	`manual_discount_mode` text DEFAULT 'none' NOT NULL,
	`manual_discount_value` integer DEFAULT 0 NOT NULL,
	`manual_discount_reason` text,
	`override_approved_by_user_id` text,
	`override_approved_amount` integer,
	`override_approved_at_ms` integer,
	FOREIGN KEY (`cashier_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`override_approved_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "chk_local_carts_created_at_ms_int" CHECK(typeof("local_carts"."created_at_ms") = 'integer'),
	CONSTRAINT "chk_local_carts_updated_at_ms_int" CHECK(typeof("local_carts"."updated_at_ms") = 'integer'),
	CONSTRAINT "chk_local_carts_parked_at_ms_int" CHECK("local_carts"."parked_at_ms" IS NULL OR typeof("local_carts"."parked_at_ms") = 'integer'),
	CONSTRAINT "chk_local_carts_manual_discount_value_int" CHECK(typeof("local_carts"."manual_discount_value") = 'integer'),
	CONSTRAINT "chk_local_carts_override_approved_amount_int" CHECK("local_carts"."override_approved_amount" IS NULL OR typeof("local_carts"."override_approved_amount") = 'integer'),
	CONSTRAINT "chk_local_carts_override_approved_at_ms_int" CHECK("local_carts"."override_approved_at_ms" IS NULL OR typeof("local_carts"."override_approved_at_ms") = 'integer'),
	CONSTRAINT "chk_local_carts_status" CHECK("local_carts"."status" IN ('open', 'parked')),
	CONSTRAINT "chk_local_carts_park_meta" CHECK(("local_carts"."status" = 'open' AND "local_carts"."parked_at_ms" IS NULL) OR ("local_carts"."status" = 'parked' AND "local_carts"."parked_at_ms" IS NOT NULL)),
	CONSTRAINT "chk_local_carts_disc_mode" CHECK("local_carts"."manual_discount_mode" IN ('none', 'percent', 'amount')),
	CONSTRAINT "chk_local_carts_disc_val" CHECK(("local_carts"."manual_discount_mode" = 'none' AND "local_carts"."manual_discount_value" = 0) OR ("local_carts"."manual_discount_mode" = 'percent' AND "local_carts"."manual_discount_value" BETWEEN 1 AND 10000) OR ("local_carts"."manual_discount_mode" = 'amount' AND "local_carts"."manual_discount_value" > 0)),
	CONSTRAINT "chk_local_carts_override_pair" CHECK(("local_carts"."override_approved_by_user_id" IS NULL AND "local_carts"."override_approved_amount" IS NULL AND "local_carts"."override_approved_at_ms" IS NULL) OR ("local_carts"."override_approved_by_user_id" IS NOT NULL AND "local_carts"."override_approved_amount" >= 0 AND "local_carts"."override_approved_at_ms" IS NOT NULL))
);
--> statement-breakpoint
CREATE INDEX `idx_local_carts_store_status` ON `local_carts` (`organization_id`,`store_id`,`status`,`updated_at_ms`);--> statement-breakpoint
CREATE TABLE `promotions` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`device_id` text NOT NULL,
	`hlc` text NOT NULL,
	`created_at_ms` integer NOT NULL,
	`updated_at_ms` integer NOT NULL,
	`deleted_at_ms` integer,
	`target_store_id` text,
	`name` text NOT NULL,
	`type` text NOT NULL,
	`scope` text NOT NULL,
	`target_product_id` text,
	`target_category_id` text,
	`discount_percent_bp` integer,
	`discount_amount` integer,
	`buy_qty` integer,
	`free_qty` integer,
	`starts_at_ms` integer NOT NULL,
	`ends_at_ms` integer,
	`is_active` integer DEFAULT true NOT NULL,
	FOREIGN KEY (`target_product_id`) REFERENCES `products`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`target_category_id`) REFERENCES `categories`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "chk_promotions_hlc_len" CHECK(length("promotions"."hlc") = 58),
	CONSTRAINT "chk_promotions_created_at_ms_int" CHECK(typeof("promotions"."created_at_ms") = 'integer'),
	CONSTRAINT "chk_promotions_updated_at_ms_int" CHECK(typeof("promotions"."updated_at_ms") = 'integer'),
	CONSTRAINT "chk_promotions_deleted_at_ms_int" CHECK("promotions"."deleted_at_ms" IS NULL OR typeof("promotions"."deleted_at_ms") = 'integer'),
	CONSTRAINT "chk_promotions_discount_amount_int" CHECK("promotions"."discount_amount" IS NULL OR typeof("promotions"."discount_amount") = 'integer'),
	CONSTRAINT "chk_promotions_starts_at_ms_int" CHECK(typeof("promotions"."starts_at_ms") = 'integer'),
	CONSTRAINT "chk_promotions_ends_at_ms_int" CHECK("promotions"."ends_at_ms" IS NULL OR typeof("promotions"."ends_at_ms") = 'integer'),
	CONSTRAINT "chk_promotions_name_nonempty" CHECK(length(trim("promotions"."name")) >= 1),
	CONSTRAINT "chk_promotions_type" CHECK("promotions"."type" IN ('percent', 'fixed_amount', 'buy_x_get_y')),
	CONSTRAINT "chk_promotions_scope" CHECK("promotions"."scope" IN ('product', 'category', 'all')),
	CONSTRAINT "chk_promotions_is_active" CHECK("promotions"."is_active" IN (0, 1)),
	CONSTRAINT "chk_promotions_window" CHECK("promotions"."ends_at_ms" IS NULL OR "promotions"."ends_at_ms" > "promotions"."starts_at_ms"),
	CONSTRAINT "chk_promotions_scope_targets" CHECK(("promotions"."scope" = 'product' AND "promotions"."target_product_id" IS NOT NULL AND "promotions"."target_category_id" IS NULL) OR ("promotions"."scope" = 'category' AND "promotions"."target_category_id" IS NOT NULL AND "promotions"."target_product_id" IS NULL) OR ("promotions"."scope" = 'all' AND "promotions"."target_product_id" IS NULL AND "promotions"."target_category_id" IS NULL)),
	CONSTRAINT "chk_promotions_type_fields" CHECK(("promotions"."type" = 'percent' AND "promotions"."discount_percent_bp" BETWEEN 1 AND 10000 AND "promotions"."discount_amount" IS NULL AND "promotions"."buy_qty" IS NULL AND "promotions"."free_qty" IS NULL) OR ("promotions"."type" = 'fixed_amount' AND "promotions"."discount_amount" > 0 AND "promotions"."discount_percent_bp" IS NULL AND "promotions"."buy_qty" IS NULL AND "promotions"."free_qty" IS NULL) OR ("promotions"."type" = 'buy_x_get_y' AND "promotions"."buy_qty" >= 1 AND "promotions"."free_qty" >= 1 AND "promotions"."discount_percent_bp" IS NULL AND "promotions"."discount_amount" IS NULL))
);
--> statement-breakpoint
CREATE INDEX `idx_promotions_org_active` ON `promotions` (`organization_id`,`deleted_at_ms`,`is_active`,`starts_at_ms`,`ends_at_ms`);--> statement-breakpoint
ALTER TABLE `local_hub_config` ADD `cashier_discount_percent_unlimited` integer DEFAULT 0 NOT NULL CHECK ("cashier_discount_percent_unlimited" IN (0, 1));--> statement-breakpoint
ALTER TABLE `local_hub_config` ADD `cashier_max_discount_percent_bp` integer DEFAULT 0 NOT NULL CHECK ("cashier_max_discount_percent_bp" >= 0 AND "cashier_max_discount_percent_bp" <= 10000);--> statement-breakpoint
ALTER TABLE `local_hub_config` ADD `cashier_discount_amount_unlimited` integer DEFAULT 0 NOT NULL CHECK ("cashier_discount_amount_unlimited" IN (0, 1));--> statement-breakpoint
ALTER TABLE `local_hub_config` ADD `cashier_max_discount_amount` integer DEFAULT 0 NOT NULL CHECK (typeof("cashier_max_discount_amount") = 'integer' AND "cashier_max_discount_amount" >= 0);--> statement-breakpoint
ALTER TABLE `local_hub_config` ADD `quick_sale_default_mxik` text;--> statement-breakpoint
ALTER TABLE `local_hub_config` ADD `quick_sale_default_vat_rate_bp` integer CHECK ("quick_sale_default_vat_rate_bp" IS NULL OR ("quick_sale_default_vat_rate_bp" >= 0 AND "quick_sale_default_vat_rate_bp" <= 10000));--> statement-breakpoint
DROP TRIGGER IF EXISTS "trg_promotions_no_delete";--> statement-breakpoint
CREATE TRIGGER "trg_promotions_no_delete"
BEFORE DELETE ON "promotions"
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'ATTR table "promotions" forbids physical DELETE: use tombstone');
END;