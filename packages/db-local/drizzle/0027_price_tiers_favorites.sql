CREATE TABLE `local_product_favorites` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`store_id` text NOT NULL,
	`created_at_ms` integer NOT NULL,
	`updated_at_ms` integer NOT NULL,
	`product_id` text NOT NULL,
	FOREIGN KEY (`product_id`) REFERENCES `products`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "chk_local_product_favorites_created_at_ms_int" CHECK(typeof("local_product_favorites"."created_at_ms") = 'integer'),
	CONSTRAINT "chk_local_product_favorites_updated_at_ms_int" CHECK(typeof("local_product_favorites"."updated_at_ms") = 'integer')
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uidx_local_product_favorites_store_product` ON `local_product_favorites` (`store_id`,`product_id`);--> statement-breakpoint
CREATE TABLE `product_price_tiers` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`device_id` text NOT NULL,
	`hlc` text NOT NULL,
	`created_at_ms` integer NOT NULL,
	`updated_at_ms` integer NOT NULL,
	`deleted_at_ms` integer,
	`product_id` text NOT NULL,
	`min_qty` integer NOT NULL,
	`unit_price` integer NOT NULL,
	FOREIGN KEY (`product_id`) REFERENCES `products`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "chk_product_price_tiers_hlc_len" CHECK(length("product_price_tiers"."hlc") = 58),
	CONSTRAINT "chk_product_price_tiers_created_at_ms_int" CHECK(typeof("product_price_tiers"."created_at_ms") = 'integer'),
	CONSTRAINT "chk_product_price_tiers_updated_at_ms_int" CHECK(typeof("product_price_tiers"."updated_at_ms") = 'integer'),
	CONSTRAINT "chk_product_price_tiers_deleted_at_ms_int" CHECK("product_price_tiers"."deleted_at_ms" IS NULL OR typeof("product_price_tiers"."deleted_at_ms") = 'integer'),
	CONSTRAINT "chk_product_price_tiers_min_qty_int" CHECK(typeof("product_price_tiers"."min_qty") = 'integer'),
	CONSTRAINT "chk_product_price_tiers_unit_price_int" CHECK(typeof("product_price_tiers"."unit_price") = 'integer'),
	CONSTRAINT "chk_product_price_tiers_min_qty_pos" CHECK("product_price_tiers"."min_qty" > 0),
	CONSTRAINT "chk_product_price_tiers_price_nonneg" CHECK("product_price_tiers"."unit_price" >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uidx_product_price_tiers_org_product_min` ON `product_price_tiers` (`organization_id`,`product_id`,`min_qty`) WHERE "product_price_tiers"."deleted_at_ms" IS NULL;--> statement-breakpoint
DROP TRIGGER IF EXISTS "trg_product_price_tiers_no_delete";--> statement-breakpoint
CREATE TRIGGER "trg_product_price_tiers_no_delete"
BEFORE DELETE ON "product_price_tiers"
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'ATTR table "product_price_tiers" forbids physical DELETE: use tombstone');
END;
