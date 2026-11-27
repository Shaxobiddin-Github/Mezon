CREATE TABLE `product_images` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`device_id` text NOT NULL,
	`hlc` text NOT NULL,
	`created_at_ms` integer NOT NULL,
	`updated_at_ms` integer NOT NULL,
	`deleted_at_ms` integer,
	`product_id` text NOT NULL,
	`mime` text NOT NULL,
	`data_base64` text NOT NULL,
	`byte_size` integer NOT NULL,
	FOREIGN KEY (`product_id`) REFERENCES `products`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "chk_product_images_hlc_len" CHECK(length("product_images"."hlc") = 58),
	CONSTRAINT "chk_product_images_created_at_ms_int" CHECK(typeof("product_images"."created_at_ms") = 'integer'),
	CONSTRAINT "chk_product_images_updated_at_ms_int" CHECK(typeof("product_images"."updated_at_ms") = 'integer'),
	CONSTRAINT "chk_product_images_deleted_at_ms_int" CHECK("product_images"."deleted_at_ms" IS NULL OR typeof("product_images"."deleted_at_ms") = 'integer'),
	CONSTRAINT "chk_product_images_mime" CHECK("product_images"."mime" IN ('image/jpeg', 'image/webp', 'image/png')),
	CONSTRAINT "chk_product_images_size" CHECK("product_images"."byte_size" > 0 AND "product_images"."byte_size" <= 160000)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uidx_product_images_org_product` ON `product_images` (`organization_id`,`product_id`) WHERE "product_images"."deleted_at_ms" IS NULL;--> statement-breakpoint
DROP TRIGGER IF EXISTS "trg_product_images_no_delete";--> statement-breakpoint
CREATE TRIGGER "trg_product_images_no_delete"
BEFORE DELETE ON "product_images"
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'ATTR table "product_images" forbids physical DELETE: use tombstone');
END;
