CREATE TABLE `payments` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`store_id` text NOT NULL,
	`device_id` text NOT NULL,
	`hlc` text NOT NULL,
	`created_at_ms` integer NOT NULL,
	`sale_id` text NOT NULL,
	`method` text NOT NULL,
	`amount` integer NOT NULL,
	`tendered_amount` integer,
	`change_amount` integer DEFAULT 0 NOT NULL,
	`provider_ref` text,
	`provider_meta_json` text,
	FOREIGN KEY (`sale_id`) REFERENCES `sales`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "chk_payments_hlc_len" CHECK(length("payments"."hlc") = 58),
	CONSTRAINT "chk_payments_created_at_ms_int" CHECK(typeof("payments"."created_at_ms") = 'integer'),
	CONSTRAINT "chk_payments_amount_int" CHECK(typeof("payments"."amount") = 'integer'),
	CONSTRAINT "chk_payments_tendered_amount_int" CHECK("payments"."tendered_amount" IS NULL OR typeof("payments"."tendered_amount") = 'integer'),
	CONSTRAINT "chk_payments_change_amount_int" CHECK(typeof("payments"."change_amount") = 'integer'),
	CONSTRAINT "chk_payments_method" CHECK("payments"."method" IN ('cash', 'card', 'uzqr', 'payme', 'click', 'uzum', 'social_card', 'other')),
	CONSTRAINT "chk_payments_nonneg" CHECK("payments"."amount" >= 0 AND "payments"."change_amount" >= 0),
	CONSTRAINT "chk_payments_cash_balance" CHECK(("payments"."method" = 'cash' AND "payments"."tendered_amount" IS NOT NULL AND "payments"."tendered_amount" >= "payments"."amount" AND "payments"."tendered_amount" - "payments"."change_amount" = "payments"."amount") OR ("payments"."method" <> 'cash' AND "payments"."change_amount" = 0))
);
--> statement-breakpoint
CREATE INDEX `idx_payments_sale` ON `payments` (`sale_id`);--> statement-breakpoint
CREATE INDEX `idx_payments_store_created` ON `payments` (`organization_id`,`store_id`,`created_at_ms`);--> statement-breakpoint
CREATE TABLE `sale_lines` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`store_id` text NOT NULL,
	`device_id` text NOT NULL,
	`hlc` text NOT NULL,
	`created_at_ms` integer NOT NULL,
	`sale_id` text NOT NULL,
	`sort_order` integer NOT NULL,
	`line_kind` text NOT NULL,
	`product_id` text,
	`variant_id` text,
	`category_id_snapshot` text,
	`item_name` text NOT NULL,
	`unit` text NOT NULL,
	`qty` integer NOT NULL,
	`unit_price_snapshot` integer NOT NULL,
	`applied_promotion_id` text,
	`applied_promotion_name` text,
	`free_units` integer DEFAULT 0 NOT NULL,
	`gross_total` integer NOT NULL,
	`promo_discount` integer NOT NULL,
	`subtotal_after_promo` integer NOT NULL,
	`allocated_order_discount` integer NOT NULL,
	`final_total` integer NOT NULL,
	`vat_rate_bp_snapshot` integer NOT NULL,
	`net_ex_vat` integer NOT NULL,
	`vat_total` integer NOT NULL,
	`mxik_snapshot` text,
	`package_code_snapshot` text,
	`cost_value` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`sale_id`) REFERENCES `sales`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`product_id`) REFERENCES `products`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`variant_id`) REFERENCES `product_variants`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "chk_sale_lines_hlc_len" CHECK(length("sale_lines"."hlc") = 58),
	CONSTRAINT "chk_sale_lines_created_at_ms_int" CHECK(typeof("sale_lines"."created_at_ms") = 'integer'),
	CONSTRAINT "chk_sale_lines_qty_int" CHECK(typeof("sale_lines"."qty") = 'integer'),
	CONSTRAINT "chk_sale_lines_unit_price_snapshot_int" CHECK(typeof("sale_lines"."unit_price_snapshot") = 'integer'),
	CONSTRAINT "chk_sale_lines_free_units_int" CHECK(typeof("sale_lines"."free_units") = 'integer'),
	CONSTRAINT "chk_sale_lines_gross_total_int" CHECK(typeof("sale_lines"."gross_total") = 'integer'),
	CONSTRAINT "chk_sale_lines_promo_discount_int" CHECK(typeof("sale_lines"."promo_discount") = 'integer'),
	CONSTRAINT "chk_sale_lines_subtotal_after_promo_int" CHECK(typeof("sale_lines"."subtotal_after_promo") = 'integer'),
	CONSTRAINT "chk_sale_lines_allocated_order_discount_int" CHECK(typeof("sale_lines"."allocated_order_discount") = 'integer'),
	CONSTRAINT "chk_sale_lines_final_total_int" CHECK(typeof("sale_lines"."final_total") = 'integer'),
	CONSTRAINT "chk_sale_lines_net_ex_vat_int" CHECK(typeof("sale_lines"."net_ex_vat") = 'integer'),
	CONSTRAINT "chk_sale_lines_vat_total_int" CHECK(typeof("sale_lines"."vat_total") = 'integer'),
	CONSTRAINT "chk_sale_lines_cost_value_int" CHECK(typeof("sale_lines"."cost_value") = 'integer'),
	CONSTRAINT "chk_sale_lines_sort_nonneg" CHECK("sale_lines"."sort_order" >= 0),
	CONSTRAINT "chk_sale_lines_kind" CHECK("sale_lines"."line_kind" IN ('catalog', 'quick_sale')),
	CONSTRAINT "chk_sale_lines_kind_product" CHECK(("sale_lines"."line_kind" = 'catalog' AND "sale_lines"."product_id" IS NOT NULL) OR ("sale_lines"."line_kind" = 'quick_sale' AND "sale_lines"."product_id" IS NULL AND "sale_lines"."variant_id" IS NULL)),
	CONSTRAINT "chk_sale_lines_name_nonempty" CHECK(length(trim("sale_lines"."item_name")) >= 1),
	CONSTRAINT "chk_sale_lines_unit" CHECK("sale_lines"."unit" IN ('dona', 'kg', 'g', 'litr', 'metr', 'm2', 'qadoq')),
	CONSTRAINT "chk_sale_lines_qty_pos" CHECK("sale_lines"."qty" > 0),
	CONSTRAINT "chk_sale_lines_unit_int" CHECK("sale_lines"."unit" NOT IN ('dona', 'qadoq') OR ("sale_lines"."qty" % 1000) = 0),
	CONSTRAINT "chk_sale_lines_money_nonneg" CHECK("sale_lines"."unit_price_snapshot" >= 0 AND "sale_lines"."free_units" >= 0 AND "sale_lines"."gross_total" >= 0 AND "sale_lines"."promo_discount" >= 0 AND "sale_lines"."subtotal_after_promo" >= 0 AND "sale_lines"."allocated_order_discount" >= 0 AND "sale_lines"."final_total" >= 0 AND "sale_lines"."net_ex_vat" >= 0 AND "sale_lines"."vat_total" >= 0 AND "sale_lines"."cost_value" >= 0),
	CONSTRAINT "chk_sale_lines_vat_bp" CHECK("sale_lines"."vat_rate_bp_snapshot" >= 0 AND "sale_lines"."vat_rate_bp_snapshot" <= 10000),
	CONSTRAINT "chk_sale_lines_arithmetic" CHECK("sale_lines"."subtotal_after_promo" = "sale_lines"."gross_total" - "sale_lines"."promo_discount" AND "sale_lines"."final_total" = "sale_lines"."subtotal_after_promo" - "sale_lines"."allocated_order_discount" AND "sale_lines"."net_ex_vat" + "sale_lines"."vat_total" = "sale_lines"."final_total")
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uidx_sale_lines_sale_sort` ON `sale_lines` (`sale_id`,`sort_order`);--> statement-breakpoint
CREATE INDEX `idx_sale_lines_store_sale` ON `sale_lines` (`organization_id`,`store_id`,`sale_id`);--> statement-breakpoint
CREATE TABLE `sales` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`store_id` text NOT NULL,
	`device_id` text NOT NULL,
	`hlc` text NOT NULL,
	`created_at_ms` integer NOT NULL,
	`updated_at_ms` integer NOT NULL,
	`receipt_no` integer NOT NULL,
	`receipt_code` text NOT NULL,
	`source_cart_id` text,
	`cashier_user_id` text NOT NULL,
	`customer_id` text,
	`shift_id` text,
	`client_request_id` text NOT NULL,
	`subtotal_gross` integer NOT NULL,
	`total_promo_discount` integer NOT NULL,
	`subtotal_after_promo` integer NOT NULL,
	`manual_discount_mode` text NOT NULL,
	`manual_discount_value` integer NOT NULL,
	`manual_discount_reason` text,
	`order_discount_amount` integer NOT NULL,
	`total_final` integer NOT NULL,
	`total_net_ex_vat` integer NOT NULL,
	`total_vat` integer NOT NULL,
	`total_paid` integer NOT NULL,
	`debt_amount` integer DEFAULT 0 NOT NULL,
	`change_amount` integer NOT NULL,
	`override_approved_by_user_id` text,
	`override_approved_amount` integer,
	`override_approved_at_ms` integer,
	`voided_at_ms` integer,
	`voided_by_user_id` text,
	`void_reason` text,
	FOREIGN KEY (`cashier_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`override_approved_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`voided_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "chk_sales_hlc_len" CHECK(length("sales"."hlc") = 58),
	CONSTRAINT "chk_sales_created_at_ms_int" CHECK(typeof("sales"."created_at_ms") = 'integer'),
	CONSTRAINT "chk_sales_updated_at_ms_int" CHECK(typeof("sales"."updated_at_ms") = 'integer'),
	CONSTRAINT "chk_sales_receipt_no_int" CHECK(typeof("sales"."receipt_no") = 'integer'),
	CONSTRAINT "chk_sales_subtotal_gross_int" CHECK(typeof("sales"."subtotal_gross") = 'integer'),
	CONSTRAINT "chk_sales_total_promo_discount_int" CHECK(typeof("sales"."total_promo_discount") = 'integer'),
	CONSTRAINT "chk_sales_subtotal_after_promo_int" CHECK(typeof("sales"."subtotal_after_promo") = 'integer'),
	CONSTRAINT "chk_sales_manual_discount_value_int" CHECK(typeof("sales"."manual_discount_value") = 'integer'),
	CONSTRAINT "chk_sales_order_discount_amount_int" CHECK(typeof("sales"."order_discount_amount") = 'integer'),
	CONSTRAINT "chk_sales_total_final_int" CHECK(typeof("sales"."total_final") = 'integer'),
	CONSTRAINT "chk_sales_total_net_ex_vat_int" CHECK(typeof("sales"."total_net_ex_vat") = 'integer'),
	CONSTRAINT "chk_sales_total_vat_int" CHECK(typeof("sales"."total_vat") = 'integer'),
	CONSTRAINT "chk_sales_total_paid_int" CHECK(typeof("sales"."total_paid") = 'integer'),
	CONSTRAINT "chk_sales_debt_amount_int" CHECK(typeof("sales"."debt_amount") = 'integer'),
	CONSTRAINT "chk_sales_change_amount_int" CHECK(typeof("sales"."change_amount") = 'integer'),
	CONSTRAINT "chk_sales_override_approved_amount_int" CHECK("sales"."override_approved_amount" IS NULL OR typeof("sales"."override_approved_amount") = 'integer'),
	CONSTRAINT "chk_sales_override_approved_at_ms_int" CHECK("sales"."override_approved_at_ms" IS NULL OR typeof("sales"."override_approved_at_ms") = 'integer'),
	CONSTRAINT "chk_sales_voided_at_ms_int" CHECK("sales"."voided_at_ms" IS NULL OR typeof("sales"."voided_at_ms") = 'integer'),
	CONSTRAINT "chk_sales_receipt_no_pos" CHECK("sales"."receipt_no" >= 1),
	CONSTRAINT "chk_sales_receipt_code_nonempty" CHECK(length(trim("sales"."receipt_code")) >= 1),
	CONSTRAINT "chk_sales_disc_mode" CHECK("sales"."manual_discount_mode" IN ('none', 'percent', 'amount')),
	CONSTRAINT "chk_sales_disc_val" CHECK(("sales"."manual_discount_mode" = 'none' AND "sales"."manual_discount_value" = 0) OR ("sales"."manual_discount_mode" = 'percent' AND "sales"."manual_discount_value" BETWEEN 1 AND 10000) OR ("sales"."manual_discount_mode" = 'amount' AND "sales"."manual_discount_value" > 0)),
	CONSTRAINT "chk_sales_money_nonneg" CHECK("sales"."subtotal_gross" >= 0 AND "sales"."total_promo_discount" >= 0 AND "sales"."subtotal_after_promo" >= 0 AND "sales"."order_discount_amount" >= 0 AND "sales"."total_final" >= 0 AND "sales"."total_net_ex_vat" >= 0 AND "sales"."total_vat" >= 0 AND "sales"."total_paid" >= 0 AND "sales"."debt_amount" >= 0 AND "sales"."change_amount" >= 0),
	CONSTRAINT "chk_sales_totals_balance" CHECK("sales"."total_paid" + "sales"."debt_amount" = "sales"."total_final" AND "sales"."total_net_ex_vat" + "sales"."total_vat" = "sales"."total_final"),
	CONSTRAINT "chk_sales_override_pair" CHECK(("sales"."override_approved_by_user_id" IS NULL AND "sales"."override_approved_amount" IS NULL AND "sales"."override_approved_at_ms" IS NULL) OR ("sales"."override_approved_by_user_id" IS NOT NULL AND "sales"."override_approved_amount" >= 0 AND "sales"."override_approved_at_ms" IS NOT NULL)),
	CONSTRAINT "chk_sales_void_pair" CHECK(("sales"."voided_at_ms" IS NULL AND "sales"."voided_by_user_id" IS NULL) OR ("sales"."voided_at_ms" IS NOT NULL AND "sales"."voided_by_user_id" IS NOT NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uidx_sales_org_device_receipt_no` ON `sales` (`organization_id`,`device_id`,`receipt_no`);--> statement-breakpoint
CREATE UNIQUE INDEX `uidx_sales_org_client_request` ON `sales` (`organization_id`,`client_request_id`);--> statement-breakpoint
CREATE INDEX `idx_sales_store_created` ON `sales` (`organization_id`,`store_id`,`created_at_ms`);--> statement-breakpoint
CREATE INDEX `idx_sales_store_cart` ON `sales` (`organization_id`,`store_id`,`source_cart_id`);--> statement-breakpoint
ALTER TABLE `local_device_state` ADD `last_receipt_seq` integer DEFAULT 0 NOT NULL CHECK (typeof("last_receipt_seq") = 'integer' AND "last_receipt_seq" >= 0);--> statement-breakpoint
CREATE TABLE `__new_local_carts` (
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
	`completed_sale_id` text,
	`completed_at_ms` integer,
	`completion_warnings_json` text,
	FOREIGN KEY (`cashier_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`override_approved_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "chk_local_carts_created_at_ms_int" CHECK(typeof("__new_local_carts"."created_at_ms") = 'integer'),
	CONSTRAINT "chk_local_carts_updated_at_ms_int" CHECK(typeof("__new_local_carts"."updated_at_ms") = 'integer'),
	CONSTRAINT "chk_local_carts_parked_at_ms_int" CHECK("__new_local_carts"."parked_at_ms" IS NULL OR typeof("__new_local_carts"."parked_at_ms") = 'integer'),
	CONSTRAINT "chk_local_carts_manual_discount_value_int" CHECK(typeof("__new_local_carts"."manual_discount_value") = 'integer'),
	CONSTRAINT "chk_local_carts_override_approved_amount_int" CHECK("__new_local_carts"."override_approved_amount" IS NULL OR typeof("__new_local_carts"."override_approved_amount") = 'integer'),
	CONSTRAINT "chk_local_carts_override_approved_at_ms_int" CHECK("__new_local_carts"."override_approved_at_ms" IS NULL OR typeof("__new_local_carts"."override_approved_at_ms") = 'integer'),
	CONSTRAINT "chk_local_carts_completed_at_ms_int" CHECK("__new_local_carts"."completed_at_ms" IS NULL OR typeof("__new_local_carts"."completed_at_ms") = 'integer'),
	CONSTRAINT "chk_local_carts_status" CHECK("__new_local_carts"."status" IN ('open', 'parked', 'completed')),
	CONSTRAINT "chk_local_carts_park_meta" CHECK(("__new_local_carts"."status" IN ('open', 'completed') AND "__new_local_carts"."parked_at_ms" IS NULL) OR ("__new_local_carts"."status" = 'parked' AND "__new_local_carts"."parked_at_ms" IS NOT NULL)),
	CONSTRAINT "chk_local_carts_completed_meta" CHECK(("__new_local_carts"."status" <> 'completed' AND "__new_local_carts"."completed_sale_id" IS NULL AND "__new_local_carts"."completed_at_ms" IS NULL) OR ("__new_local_carts"."status" = 'completed' AND "__new_local_carts"."completed_sale_id" IS NOT NULL AND "__new_local_carts"."completed_at_ms" IS NOT NULL)),
	CONSTRAINT "chk_local_carts_disc_mode" CHECK("__new_local_carts"."manual_discount_mode" IN ('none', 'percent', 'amount')),
	CONSTRAINT "chk_local_carts_disc_val" CHECK(("__new_local_carts"."manual_discount_mode" = 'none' AND "__new_local_carts"."manual_discount_value" = 0) OR ("__new_local_carts"."manual_discount_mode" = 'percent' AND "__new_local_carts"."manual_discount_value" BETWEEN 1 AND 10000) OR ("__new_local_carts"."manual_discount_mode" = 'amount' AND "__new_local_carts"."manual_discount_value" > 0)),
	CONSTRAINT "chk_local_carts_override_pair" CHECK(("__new_local_carts"."override_approved_by_user_id" IS NULL AND "__new_local_carts"."override_approved_amount" IS NULL AND "__new_local_carts"."override_approved_at_ms" IS NULL) OR ("__new_local_carts"."override_approved_by_user_id" IS NOT NULL AND "__new_local_carts"."override_approved_amount" >= 0 AND "__new_local_carts"."override_approved_at_ms" IS NOT NULL))
);--> statement-breakpoint
INSERT INTO `__new_local_carts`("id", "organization_id", "store_id", "created_at_ms", "updated_at_ms", "cashier_user_id", "status", "park_label", "parked_at_ms", "manual_discount_mode", "manual_discount_value", "manual_discount_reason", "override_approved_by_user_id", "override_approved_amount", "override_approved_at_ms", "completed_sale_id", "completed_at_ms", "completion_warnings_json") SELECT "id", "organization_id", "store_id", "created_at_ms", "updated_at_ms", "cashier_user_id", "status", "park_label", "parked_at_ms", "manual_discount_mode", "manual_discount_value", "manual_discount_reason", "override_approved_by_user_id", "override_approved_amount", "override_approved_at_ms", NULL, NULL, NULL FROM `local_carts`;--> statement-breakpoint
CREATE TABLE `__tmp_local_cart_lines` AS SELECT * FROM `local_cart_lines`;--> statement-breakpoint
DROP TABLE `local_cart_lines`;--> statement-breakpoint
DROP TABLE `local_carts`;--> statement-breakpoint
ALTER TABLE `__new_local_carts` RENAME TO `local_carts`;--> statement-breakpoint
CREATE INDEX `idx_local_carts_store_status` ON `local_carts` (`organization_id`,`store_id`,`status`,`updated_at_ms`);--> statement-breakpoint
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
);--> statement-breakpoint
INSERT INTO `local_cart_lines` SELECT * FROM `__tmp_local_cart_lines`;--> statement-breakpoint
DROP TABLE `__tmp_local_cart_lines`;--> statement-breakpoint
CREATE INDEX `idx_local_cart_lines_cart_sort` ON `local_cart_lines` (`cart_id`,`sort_order`,`id`);--> statement-breakpoint
DROP TRIGGER IF EXISTS "trg_sales_no_delete";--> statement-breakpoint
CREATE TRIGGER "trg_sales_no_delete"
BEFORE DELETE ON "sales"
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'MONOTONE table "sales" forbids physical DELETE: use tombstone');
END;--> statement-breakpoint
DROP TRIGGER IF EXISTS "trg_sale_lines_no_update";--> statement-breakpoint
CREATE TRIGGER "trg_sale_lines_no_update"
BEFORE UPDATE ON "sale_lines"
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'FACT table "sale_lines" is immutable: UPDATE is forbidden');
END;--> statement-breakpoint
DROP TRIGGER IF EXISTS "trg_sale_lines_no_delete";--> statement-breakpoint
CREATE TRIGGER "trg_sale_lines_no_delete"
BEFORE DELETE ON "sale_lines"
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'FACT table "sale_lines" forbids physical DELETE: use tombstone');
END;--> statement-breakpoint
DROP TRIGGER IF EXISTS "trg_payments_no_update";--> statement-breakpoint
CREATE TRIGGER "trg_payments_no_update"
BEFORE UPDATE ON "payments"
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'FACT table "payments" is immutable: UPDATE is forbidden');
END;--> statement-breakpoint
DROP TRIGGER IF EXISTS "trg_payments_no_delete";--> statement-breakpoint
CREATE TRIGGER "trg_payments_no_delete"
BEFORE DELETE ON "payments"
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'FACT table "payments" forbids physical DELETE: use tombstone');
END;--> statement-breakpoint
DROP TRIGGER IF EXISTS "trg_sales_voided_monotone";--> statement-breakpoint
CREATE TRIGGER "trg_sales_voided_monotone"
BEFORE UPDATE ON "sales"
FOR EACH ROW
WHEN OLD."voided_at_ms" IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'MONOTONE table "sales" cannot be modified once voided');
END;--> statement-breakpoint
DROP TRIGGER IF EXISTS "trg_sales_immutable_core";--> statement-breakpoint
CREATE TRIGGER "trg_sales_immutable_core"
BEFORE UPDATE ON "sales"
FOR EACH ROW
WHEN
  NEW."voided_at_ms" IS NULL OR
  NEW."id" IS NOT OLD."id" OR
  NEW."organization_id" IS NOT OLD."organization_id" OR
  NEW."store_id" IS NOT OLD."store_id" OR
  NEW."receipt_no" IS NOT OLD."receipt_no" OR
  NEW."receipt_code" IS NOT OLD."receipt_code" OR
  NEW."source_cart_id" IS NOT OLD."source_cart_id" OR
  NEW."cashier_user_id" IS NOT OLD."cashier_user_id" OR
  NEW."customer_id" IS NOT OLD."customer_id" OR
  NEW."shift_id" IS NOT OLD."shift_id" OR
  NEW."client_request_id" IS NOT OLD."client_request_id" OR
  NEW."subtotal_gross" IS NOT OLD."subtotal_gross" OR
  NEW."total_promo_discount" IS NOT OLD."total_promo_discount" OR
  NEW."subtotal_after_promo" IS NOT OLD."subtotal_after_promo" OR
  NEW."manual_discount_mode" IS NOT OLD."manual_discount_mode" OR
  NEW."manual_discount_value" IS NOT OLD."manual_discount_value" OR
  NEW."manual_discount_reason" IS NOT OLD."manual_discount_reason" OR
  NEW."order_discount_amount" IS NOT OLD."order_discount_amount" OR
  NEW."total_final" IS NOT OLD."total_final" OR
  NEW."total_net_ex_vat" IS NOT OLD."total_net_ex_vat" OR
  NEW."total_vat" IS NOT OLD."total_vat" OR
  NEW."total_paid" IS NOT OLD."total_paid" OR
  NEW."debt_amount" IS NOT OLD."debt_amount" OR
  NEW."change_amount" IS NOT OLD."change_amount" OR
  NEW."override_approved_by_user_id" IS NOT OLD."override_approved_by_user_id" OR
  NEW."override_approved_amount" IS NOT OLD."override_approved_amount" OR
  NEW."override_approved_at_ms" IS NOT OLD."override_approved_at_ms" OR
  NEW."created_at_ms" IS NOT OLD."created_at_ms"
BEGIN
  SELECT RAISE(ABORT, 'MONOTONE table "sales" forbids updating immutable receipt fields');
END;