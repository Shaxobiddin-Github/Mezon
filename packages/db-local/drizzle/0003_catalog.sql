CREATE TABLE `categories` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`device_id` text NOT NULL,
	`hlc` text NOT NULL,
	`created_at_ms` integer NOT NULL,
	`updated_at_ms` integer NOT NULL,
	`deleted_at_ms` integer,
	`name` text NOT NULL,
	`name_search` text NOT NULL,
	`parent_id` text,
	`sort_order` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`parent_id`) REFERENCES `categories`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "chk_categories_hlc_len" CHECK(length("categories"."hlc") = 58),
	CONSTRAINT "chk_categories_created_at_ms_int" CHECK(typeof("categories"."created_at_ms") = 'integer'),
	CONSTRAINT "chk_categories_updated_at_ms_int" CHECK(typeof("categories"."updated_at_ms") = 'integer'),
	CONSTRAINT "chk_categories_deleted_at_ms_int" CHECK("categories"."deleted_at_ms" IS NULL OR typeof("categories"."deleted_at_ms") = 'integer'),
	CONSTRAINT "chk_categories_name_nonempty" CHECK(length(trim("categories"."name")) >= 1),
	CONSTRAINT "chk_categories_not_self_parent" CHECK("categories"."parent_id" IS NULL OR "categories"."parent_id" <> "categories"."id")
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uidx_categories_org_root_name` ON `categories` (`organization_id`,`name_search`) WHERE "categories"."parent_id" IS NULL AND "categories"."deleted_at_ms" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `uidx_categories_org_child_name` ON `categories` (`organization_id`,`parent_id`,`name_search`) WHERE "categories"."parent_id" IS NOT NULL AND "categories"."deleted_at_ms" IS NULL;--> statement-breakpoint
CREATE INDEX `idx_categories_org_parent` ON `categories` (`organization_id`,`parent_id`) WHERE "categories"."deleted_at_ms" IS NULL;--> statement-breakpoint
CREATE TABLE `price_changes` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`device_id` text NOT NULL,
	`hlc` text NOT NULL,
	`created_at_ms` integer NOT NULL,
	`product_id` text NOT NULL,
	`variant_id` text,
	`old_price` integer,
	`new_price` integer NOT NULL,
	`changed_by_user_id` text NOT NULL,
	`reason` text,
	FOREIGN KEY (`product_id`) REFERENCES `products`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`variant_id`) REFERENCES `product_variants`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`changed_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "chk_price_changes_hlc_len" CHECK(length("price_changes"."hlc") = 58),
	CONSTRAINT "chk_price_changes_created_at_ms_int" CHECK(typeof("price_changes"."created_at_ms") = 'integer'),
	CONSTRAINT "chk_price_changes_old_price_int" CHECK("price_changes"."old_price" IS NULL OR typeof("price_changes"."old_price") = 'integer'),
	CONSTRAINT "chk_price_changes_new_price_int" CHECK(typeof("price_changes"."new_price") = 'integer'),
	CONSTRAINT "chk_price_changes_old_price_nonneg" CHECK("price_changes"."old_price" IS NULL OR "price_changes"."old_price" >= 0),
	CONSTRAINT "chk_price_changes_new_price_nonneg" CHECK("price_changes"."new_price" >= 0)
);
--> statement-breakpoint
CREATE INDEX `idx_price_changes_org_product_time` ON `price_changes` (`organization_id`,`product_id`,`created_at_ms`);--> statement-breakpoint
CREATE TABLE `product_barcodes` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`device_id` text NOT NULL,
	`hlc` text NOT NULL,
	`created_at_ms` integer NOT NULL,
	`updated_at_ms` integer NOT NULL,
	`deleted_at_ms` integer,
	`product_id` text NOT NULL,
	`variant_id` text,
	`barcode` text NOT NULL,
	`format` text NOT NULL,
	FOREIGN KEY (`product_id`) REFERENCES `products`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`variant_id`) REFERENCES `product_variants`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "chk_product_barcodes_hlc_len" CHECK(length("product_barcodes"."hlc") = 58),
	CONSTRAINT "chk_product_barcodes_created_at_ms_int" CHECK(typeof("product_barcodes"."created_at_ms") = 'integer'),
	CONSTRAINT "chk_product_barcodes_updated_at_ms_int" CHECK(typeof("product_barcodes"."updated_at_ms") = 'integer'),
	CONSTRAINT "chk_product_barcodes_deleted_at_ms_int" CHECK("product_barcodes"."deleted_at_ms" IS NULL OR typeof("product_barcodes"."deleted_at_ms") = 'integer'),
	CONSTRAINT "chk_product_barcodes_barcode_nonempty" CHECK(length(trim("product_barcodes"."barcode")) >= 1),
	CONSTRAINT "chk_product_barcodes_format" CHECK("product_barcodes"."format" IN ('ean13', 'ean8', 'upca', 'internal', 'other'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uidx_product_barcodes_org_barcode` ON `product_barcodes` (`organization_id`,`barcode`) WHERE "product_barcodes"."deleted_at_ms" IS NULL;--> statement-breakpoint
CREATE INDEX `idx_product_barcodes_org_product` ON `product_barcodes` (`organization_id`,`product_id`) WHERE "product_barcodes"."deleted_at_ms" IS NULL;--> statement-breakpoint
CREATE INDEX `idx_product_barcodes_org_variant` ON `product_barcodes` (`organization_id`,`variant_id`) WHERE "product_barcodes"."variant_id" IS NOT NULL AND "product_barcodes"."deleted_at_ms" IS NULL;--> statement-breakpoint
CREATE TABLE `product_variants` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`device_id` text NOT NULL,
	`hlc` text NOT NULL,
	`created_at_ms` integer NOT NULL,
	`updated_at_ms` integer NOT NULL,
	`deleted_at_ms` integer,
	`product_id` text NOT NULL,
	`name` text NOT NULL,
	`name_search` text NOT NULL,
	`sku` text,
	`sku_search` text,
	`attributes_json` text NOT NULL,
	`sale_price` integer,
	FOREIGN KEY (`product_id`) REFERENCES `products`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "chk_product_variants_hlc_len" CHECK(length("product_variants"."hlc") = 58),
	CONSTRAINT "chk_product_variants_created_at_ms_int" CHECK(typeof("product_variants"."created_at_ms") = 'integer'),
	CONSTRAINT "chk_product_variants_updated_at_ms_int" CHECK(typeof("product_variants"."updated_at_ms") = 'integer'),
	CONSTRAINT "chk_product_variants_deleted_at_ms_int" CHECK("product_variants"."deleted_at_ms" IS NULL OR typeof("product_variants"."deleted_at_ms") = 'integer'),
	CONSTRAINT "chk_product_variants_sale_price_int" CHECK("product_variants"."sale_price" IS NULL OR typeof("product_variants"."sale_price") = 'integer'),
	CONSTRAINT "chk_product_variants_name_nonempty" CHECK(length(trim("product_variants"."name")) >= 1),
	CONSTRAINT "chk_product_variants_attrs_json" CHECK(json_valid("product_variants"."attributes_json") = 1),
	CONSTRAINT "chk_product_variants_sale_price_nonneg" CHECK("product_variants"."sale_price" IS NULL OR "product_variants"."sale_price" >= 0)
);
--> statement-breakpoint
CREATE INDEX `idx_product_variants_org_product` ON `product_variants` (`organization_id`,`product_id`) WHERE "product_variants"."deleted_at_ms" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `uidx_product_variants_org_sku` ON `product_variants` (`organization_id`,`sku`) WHERE "product_variants"."sku" IS NOT NULL AND "product_variants"."deleted_at_ms" IS NULL;--> statement-breakpoint
CREATE TABLE `products` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`device_id` text NOT NULL,
	`hlc` text NOT NULL,
	`created_at_ms` integer NOT NULL,
	`updated_at_ms` integer NOT NULL,
	`deleted_at_ms` integer,
	`category_id` text,
	`sku` text,
	`sku_search` text,
	`name` text NOT NULL,
	`name_search` text NOT NULL,
	`unit` text NOT NULL,
	`unlimited` integer DEFAULT false NOT NULL,
	`min_stock` integer,
	`has_variants` integer DEFAULT false NOT NULL,
	`sale_price` integer NOT NULL,
	`mxik` text,
	`package_code` text,
	`vat_rate_bp` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`category_id`) REFERENCES `categories`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "chk_products_hlc_len" CHECK(length("products"."hlc") = 58),
	CONSTRAINT "chk_products_created_at_ms_int" CHECK(typeof("products"."created_at_ms") = 'integer'),
	CONSTRAINT "chk_products_updated_at_ms_int" CHECK(typeof("products"."updated_at_ms") = 'integer'),
	CONSTRAINT "chk_products_deleted_at_ms_int" CHECK("products"."deleted_at_ms" IS NULL OR typeof("products"."deleted_at_ms") = 'integer'),
	CONSTRAINT "chk_products_min_stock_int" CHECK("products"."min_stock" IS NULL OR typeof("products"."min_stock") = 'integer'),
	CONSTRAINT "chk_products_sale_price_int" CHECK(typeof("products"."sale_price") = 'integer'),
	CONSTRAINT "chk_products_name_nonempty" CHECK(length(trim("products"."name")) >= 1),
	CONSTRAINT "chk_products_unit" CHECK("products"."unit" IN ('dona', 'kg', 'g', 'litr', 'metr', 'm2', 'qadoq')),
	CONSTRAINT "chk_products_unlimited" CHECK("products"."unlimited" IN (0, 1)),
	CONSTRAINT "chk_products_has_variants" CHECK("products"."has_variants" IN (0, 1)),
	CONSTRAINT "chk_products_min_stock_nonneg" CHECK("products"."min_stock" IS NULL OR "products"."min_stock" >= 0),
	CONSTRAINT "chk_products_min_stock_unit_int" CHECK("products"."min_stock" IS NULL OR "products"."unit" NOT IN ('dona', 'qadoq') OR ("products"."min_stock" % 1000) = 0),
	CONSTRAINT "chk_products_sale_price_nonneg" CHECK("products"."sale_price" >= 0),
	CONSTRAINT "chk_products_vat_rate_bp" CHECK("products"."vat_rate_bp" >= 0 AND "products"."vat_rate_bp" <= 10000)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uidx_products_org_sku` ON `products` (`organization_id`,`sku`) WHERE "products"."sku" IS NOT NULL AND "products"."deleted_at_ms" IS NULL;--> statement-breakpoint
CREATE INDEX `idx_products_org_name_search` ON `products` (`organization_id`,`name_search`,`id`) WHERE "products"."deleted_at_ms" IS NULL;--> statement-breakpoint
CREATE INDEX `idx_products_org_sku_search` ON `products` (`organization_id`,`sku_search`,`id`) WHERE "products"."sku_search" IS NOT NULL AND "products"."deleted_at_ms" IS NULL;--> statement-breakpoint
CREATE INDEX `idx_products_org_category` ON `products` (`organization_id`,`category_id`) WHERE "products"."deleted_at_ms" IS NULL;--> statement-breakpoint
CREATE INDEX `idx_products_active_join` ON `products` (`id`,`organization_id`,`category_id`) WHERE "products"."deleted_at_ms" IS NULL;--> statement-breakpoint
DROP TRIGGER IF EXISTS "trg_categories_no_delete";--> statement-breakpoint
CREATE TRIGGER "trg_categories_no_delete"
BEFORE DELETE ON "categories"
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'ATTR table "categories" forbids physical DELETE: use tombstone');
END;--> statement-breakpoint
DROP TRIGGER IF EXISTS "trg_products_no_delete";--> statement-breakpoint
CREATE TRIGGER "trg_products_no_delete"
BEFORE DELETE ON "products"
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'ATTR table "products" forbids physical DELETE: use tombstone');
END;--> statement-breakpoint
DROP TRIGGER IF EXISTS "trg_product_variants_no_delete";--> statement-breakpoint
CREATE TRIGGER "trg_product_variants_no_delete"
BEFORE DELETE ON "product_variants"
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'ATTR table "product_variants" forbids physical DELETE: use tombstone');
END;--> statement-breakpoint
DROP TRIGGER IF EXISTS "trg_product_barcodes_no_delete";--> statement-breakpoint
CREATE TRIGGER "trg_product_barcodes_no_delete"
BEFORE DELETE ON "product_barcodes"
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'ATTR table "product_barcodes" forbids physical DELETE: use tombstone');
END;--> statement-breakpoint
DROP TRIGGER IF EXISTS "trg_price_changes_no_update";--> statement-breakpoint
CREATE TRIGGER "trg_price_changes_no_update"
BEFORE UPDATE ON "price_changes"
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'FACT table "price_changes" is immutable: UPDATE is forbidden');
END;--> statement-breakpoint
DROP TRIGGER IF EXISTS "trg_price_changes_no_delete";--> statement-breakpoint
CREATE TRIGGER "trg_price_changes_no_delete"
BEFORE DELETE ON "price_changes"
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'FACT table "price_changes" forbids physical DELETE: use tombstone');
END;--> statement-breakpoint
DROP TRIGGER IF EXISTS "trg_products_fts_after_insert";--> statement-breakpoint
DROP TRIGGER IF EXISTS "trg_products_fts_after_update";--> statement-breakpoint
DROP TABLE IF EXISTS "products_fts";--> statement-breakpoint
CREATE VIRTUAL TABLE "products_fts" USING fts5(
  product_id UNINDEXED,
  organization_id UNINDEXED,
  name_search,
  sku_search,
  tokenize = 'unicode61 remove_diacritics 0',
  prefix = '2 3'
);--> statement-breakpoint
CREATE TRIGGER "trg_products_fts_after_insert"
AFTER INSERT ON "products"
FOR EACH ROW
WHEN NEW."deleted_at_ms" IS NULL
BEGIN
  INSERT INTO "products_fts" ("product_id", "organization_id", "name_search", "sku_search")
  VALUES (NEW."id", NEW."organization_id", NEW."name_search", COALESCE(NEW."sku_search", ''));
END;--> statement-breakpoint
CREATE TRIGGER "trg_products_fts_after_update"
AFTER UPDATE ON "products"
FOR EACH ROW
BEGIN
  DELETE FROM "products_fts" WHERE "product_id" = OLD."id";
  INSERT INTO "products_fts" ("product_id", "organization_id", "name_search", "sku_search")
  SELECT NEW."id", NEW."organization_id", NEW."name_search", COALESCE(NEW."sku_search", '')
  WHERE NEW."deleted_at_ms" IS NULL;
END;
