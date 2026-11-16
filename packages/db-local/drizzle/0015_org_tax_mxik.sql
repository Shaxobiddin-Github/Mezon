CREATE TABLE `organization_tax_profiles` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`device_id` text NOT NULL,
	`hlc` text NOT NULL,
	`created_at_ms` integer NOT NULL,
	`updated_at_ms` integer NOT NULL,
	`deleted_at_ms` integer,
	`tin` text NOT NULL,
	`legal_name` text NOT NULL,
	`legal_address` text NOT NULL,
	`is_vat_payer` integer NOT NULL,
	`default_vat_rate_bp` integer DEFAULT 0 NOT NULL,
	`updated_by_user_id` text NOT NULL,
	FOREIGN KEY (`updated_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "chk_organization_tax_profiles_hlc_len" CHECK(length("organization_tax_profiles"."hlc") = 58),
	CONSTRAINT "chk_organization_tax_profiles_created_at_ms_int" CHECK(typeof("organization_tax_profiles"."created_at_ms") = 'integer'),
	CONSTRAINT "chk_organization_tax_profiles_updated_at_ms_int" CHECK(typeof("organization_tax_profiles"."updated_at_ms") = 'integer'),
	CONSTRAINT "chk_organization_tax_profiles_deleted_at_ms_int" CHECK("organization_tax_profiles"."deleted_at_ms" IS NULL OR typeof("organization_tax_profiles"."deleted_at_ms") = 'integer'),
	CONSTRAINT "chk_org_tax_profiles_id_is_org" CHECK("organization_tax_profiles"."id" = "organization_tax_profiles"."organization_id"),
	CONSTRAINT "chk_org_tax_profiles_tin" CHECK(length("organization_tax_profiles"."tin") = 9 AND "organization_tax_profiles"."tin" NOT GLOB '*[^0-9]*'),
	CONSTRAINT "chk_org_tax_profiles_legal_name" CHECK(length(trim("organization_tax_profiles"."legal_name")) >= 1),
	CONSTRAINT "chk_org_tax_profiles_legal_address" CHECK(length(trim("organization_tax_profiles"."legal_address")) >= 1),
	CONSTRAINT "chk_org_tax_profiles_is_vat_payer" CHECK("organization_tax_profiles"."is_vat_payer" IN (0, 1)),
	CONSTRAINT "chk_org_tax_profiles_default_vat" CHECK("organization_tax_profiles"."default_vat_rate_bp" >= 0 AND "organization_tax_profiles"."default_vat_rate_bp" <= 10000)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uidx_org_tax_profiles_org` ON `organization_tax_profiles` (`organization_id`) WHERE "organization_tax_profiles"."deleted_at_ms" IS NULL;--> statement-breakpoint
CREATE INDEX `idx_products_org_missing_mxik` ON `products` (`organization_id`,`name_search`,`id`) WHERE "products"."mxik" IS NULL AND "products"."deleted_at_ms" IS NULL;--> statement-breakpoint
DROP TRIGGER IF EXISTS "trg_organization_tax_profiles_no_delete";--> statement-breakpoint
CREATE TRIGGER "trg_organization_tax_profiles_no_delete"
BEFORE DELETE ON "organization_tax_profiles"
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'ATTR table "organization_tax_profiles" forbids physical DELETE: use tombstone');
END;
