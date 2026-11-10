CREATE TABLE `__tmp_sale_lines` AS SELECT * FROM `sale_lines`;--> statement-breakpoint
CREATE TABLE `__tmp_payments` AS SELECT * FROM `payments`;--> statement-breakpoint
DROP TABLE `payments`;--> statement-breakpoint
DROP TABLE `sale_lines`;--> statement-breakpoint
CREATE TABLE `__new_sales` (
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
	`completed_by_user_id` text NOT NULL,
	`customer_id` text,
	`shift_id` text,
	`client_request_id` text NOT NULL,
	`request_hash` text NOT NULL,
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
	FOREIGN KEY (`completed_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`override_approved_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`voided_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "chk_sales_hlc_len" CHECK(length("__new_sales"."hlc") = 58),
	CONSTRAINT "chk_sales_created_at_ms_int" CHECK(typeof("__new_sales"."created_at_ms") = 'integer'),
	CONSTRAINT "chk_sales_updated_at_ms_int" CHECK(typeof("__new_sales"."updated_at_ms") = 'integer'),
	CONSTRAINT "chk_sales_receipt_no_int" CHECK(typeof("__new_sales"."receipt_no") = 'integer'),
	CONSTRAINT "chk_sales_subtotal_gross_int" CHECK(typeof("__new_sales"."subtotal_gross") = 'integer'),
	CONSTRAINT "chk_sales_total_promo_discount_int" CHECK(typeof("__new_sales"."total_promo_discount") = 'integer'),
	CONSTRAINT "chk_sales_subtotal_after_promo_int" CHECK(typeof("__new_sales"."subtotal_after_promo") = 'integer'),
	CONSTRAINT "chk_sales_manual_discount_value_int" CHECK(typeof("__new_sales"."manual_discount_value") = 'integer'),
	CONSTRAINT "chk_sales_order_discount_amount_int" CHECK(typeof("__new_sales"."order_discount_amount") = 'integer'),
	CONSTRAINT "chk_sales_total_final_int" CHECK(typeof("__new_sales"."total_final") = 'integer'),
	CONSTRAINT "chk_sales_total_net_ex_vat_int" CHECK(typeof("__new_sales"."total_net_ex_vat") = 'integer'),
	CONSTRAINT "chk_sales_total_vat_int" CHECK(typeof("__new_sales"."total_vat") = 'integer'),
	CONSTRAINT "chk_sales_total_paid_int" CHECK(typeof("__new_sales"."total_paid") = 'integer'),
	CONSTRAINT "chk_sales_debt_amount_int" CHECK(typeof("__new_sales"."debt_amount") = 'integer'),
	CONSTRAINT "chk_sales_change_amount_int" CHECK(typeof("__new_sales"."change_amount") = 'integer'),
	CONSTRAINT "chk_sales_override_approved_amount_int" CHECK("__new_sales"."override_approved_amount" IS NULL OR typeof("__new_sales"."override_approved_amount") = 'integer'),
	CONSTRAINT "chk_sales_override_approved_at_ms_int" CHECK("__new_sales"."override_approved_at_ms" IS NULL OR typeof("__new_sales"."override_approved_at_ms") = 'integer'),
	CONSTRAINT "chk_sales_voided_at_ms_int" CHECK("__new_sales"."voided_at_ms" IS NULL OR typeof("__new_sales"."voided_at_ms") = 'integer'),
	CONSTRAINT "chk_sales_receipt_no_pos" CHECK("__new_sales"."receipt_no" >= 1),
	CONSTRAINT "chk_sales_receipt_code_nonempty" CHECK(length(trim("__new_sales"."receipt_code")) >= 1),
	CONSTRAINT "chk_sales_request_hash_nonempty" CHECK(length(trim("__new_sales"."request_hash")) >= 6),
	CONSTRAINT "chk_sales_disc_mode" CHECK("__new_sales"."manual_discount_mode" IN ('none', 'percent', 'amount')),
	CONSTRAINT "chk_sales_disc_val" CHECK(("__new_sales"."manual_discount_mode" = 'none' AND "__new_sales"."manual_discount_value" = 0) OR ("__new_sales"."manual_discount_mode" = 'percent' AND "__new_sales"."manual_discount_value" BETWEEN 1 AND 10000) OR ("__new_sales"."manual_discount_mode" = 'amount' AND "__new_sales"."manual_discount_value" > 0)),
	CONSTRAINT "chk_sales_money_nonneg" CHECK("__new_sales"."subtotal_gross" >= 0 AND "__new_sales"."total_promo_discount" >= 0 AND "__new_sales"."subtotal_after_promo" >= 0 AND "__new_sales"."order_discount_amount" >= 0 AND "__new_sales"."total_final" >= 0 AND "__new_sales"."total_net_ex_vat" >= 0 AND "__new_sales"."total_vat" >= 0 AND "__new_sales"."total_paid" >= 0 AND "__new_sales"."debt_amount" >= 0 AND "__new_sales"."change_amount" >= 0),
	CONSTRAINT "chk_sales_totals_balance" CHECK("__new_sales"."total_paid" + "__new_sales"."debt_amount" = "__new_sales"."total_final" AND "__new_sales"."total_net_ex_vat" + "__new_sales"."total_vat" = "__new_sales"."total_final"),
	CONSTRAINT "chk_sales_override_pair" CHECK(("__new_sales"."override_approved_by_user_id" IS NULL AND "__new_sales"."override_approved_amount" IS NULL AND "__new_sales"."override_approved_at_ms" IS NULL) OR ("__new_sales"."override_approved_by_user_id" IS NOT NULL AND "__new_sales"."override_approved_amount" >= 0 AND "__new_sales"."override_approved_at_ms" IS NOT NULL)),
	CONSTRAINT "chk_sales_void_pair" CHECK(("__new_sales"."voided_at_ms" IS NULL AND "__new_sales"."voided_by_user_id" IS NULL) OR ("__new_sales"."voided_at_ms" IS NOT NULL AND "__new_sales"."voided_by_user_id" IS NOT NULL))
);--> statement-breakpoint
INSERT INTO `__new_sales`("id", "organization_id", "store_id", "device_id", "hlc", "created_at_ms", "updated_at_ms", "receipt_no", "receipt_code", "source_cart_id", "cashier_user_id", "completed_by_user_id", "customer_id", "shift_id", "client_request_id", "request_hash", "subtotal_gross", "total_promo_discount", "subtotal_after_promo", "manual_discount_mode", "manual_discount_value", "manual_discount_reason", "order_discount_amount", "total_final", "total_net_ex_vat", "total_vat", "total_paid", "debt_amount", "change_amount", "override_approved_by_user_id", "override_approved_amount", "override_approved_at_ms", "voided_at_ms", "voided_by_user_id", "void_reason") SELECT "id", "organization_id", "store_id", "device_id", "hlc", "created_at_ms", "updated_at_ms", "receipt_no", "receipt_code", "source_cart_id", "cashier_user_id", "cashier_user_id", "customer_id", "shift_id", "client_request_id", ('legacy:' || "id"), "subtotal_gross", "total_promo_discount", "subtotal_after_promo", "manual_discount_mode", "manual_discount_value", "manual_discount_reason", "order_discount_amount", "total_final", "total_net_ex_vat", "total_vat", "total_paid", "debt_amount", "change_amount", "override_approved_by_user_id", "override_approved_amount", "override_approved_at_ms", "voided_at_ms", "voided_by_user_id", "void_reason" FROM `sales`;--> statement-breakpoint
DROP TABLE `sales`;--> statement-breakpoint
ALTER TABLE `__new_sales` RENAME TO `sales`;--> statement-breakpoint
CREATE UNIQUE INDEX `uidx_sales_org_device_receipt_no` ON `sales` (`organization_id`,`device_id`,`receipt_no`);--> statement-breakpoint
CREATE UNIQUE INDEX `uidx_sales_org_client_request` ON `sales` (`organization_id`,`client_request_id`);--> statement-breakpoint
CREATE INDEX `idx_sales_store_created` ON `sales` (`organization_id`,`store_id`,`created_at_ms`);--> statement-breakpoint
CREATE INDEX `idx_sales_store_cart` ON `sales` (`organization_id`,`store_id`,`source_cart_id`);--> statement-breakpoint
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
);--> statement-breakpoint
INSERT INTO `sale_lines`("id", "organization_id", "store_id", "device_id", "hlc", "created_at_ms", "sale_id", "sort_order", "line_kind", "product_id", "variant_id", "category_id_snapshot", "item_name", "unit", "qty", "unit_price_snapshot", "applied_promotion_id", "applied_promotion_name", "free_units", "gross_total", "promo_discount", "subtotal_after_promo", "allocated_order_discount", "final_total", "vat_rate_bp_snapshot", "net_ex_vat", "vat_total", "mxik_snapshot", "package_code_snapshot", "cost_value") SELECT "id", "organization_id", "store_id", "device_id", "hlc", "created_at_ms", "sale_id", "sort_order", "line_kind", "product_id", "variant_id", "category_id_snapshot", "item_name", "unit", "qty", "unit_price_snapshot", "applied_promotion_id", "applied_promotion_name", "free_units", "gross_total", "promo_discount", "subtotal_after_promo", "allocated_order_discount", "final_total", "vat_rate_bp_snapshot", "net_ex_vat", "vat_total", "mxik_snapshot", "package_code_snapshot", "cost_value" FROM `__tmp_sale_lines`;--> statement-breakpoint
DROP TABLE `__tmp_sale_lines`;--> statement-breakpoint
CREATE UNIQUE INDEX `uidx_sale_lines_sale_sort` ON `sale_lines` (`sale_id`,`sort_order`);--> statement-breakpoint
CREATE INDEX `idx_sale_lines_store_sale` ON `sale_lines` (`organization_id`,`store_id`,`sale_id`);--> statement-breakpoint
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
	CONSTRAINT "chk_payments_nonneg" CHECK("payments"."amount" > 0 AND "payments"."change_amount" >= 0),
	CONSTRAINT "chk_payments_cash_balance" CHECK(("payments"."method" = 'cash' AND "payments"."tendered_amount" IS NOT NULL AND "payments"."tendered_amount" > 0 AND "payments"."tendered_amount" >= "payments"."amount" AND "payments"."tendered_amount" - "payments"."change_amount" = "payments"."amount") OR ("payments"."method" <> 'cash' AND "payments"."tendered_amount" IS NULL AND "payments"."change_amount" = 0))
);--> statement-breakpoint
INSERT INTO `payments`("id", "organization_id", "store_id", "device_id", "hlc", "created_at_ms", "sale_id", "method", "amount", "tendered_amount", "change_amount", "provider_ref", "provider_meta_json") SELECT "id", "organization_id", "store_id", "device_id", "hlc", "created_at_ms", "sale_id", "method", "amount", "tendered_amount", "change_amount", "provider_ref", "provider_meta_json" FROM `__tmp_payments`;--> statement-breakpoint
DROP TABLE `__tmp_payments`;--> statement-breakpoint
CREATE INDEX `idx_payments_sale` ON `payments` (`sale_id`);--> statement-breakpoint
CREATE INDEX `idx_payments_store_created` ON `payments` (`organization_id`,`store_id`,`created_at_ms`);--> statement-breakpoint
CREATE TABLE `cash_moves` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`store_id` text NOT NULL,
	`device_id` text NOT NULL,
	`hlc` text NOT NULL,
	`created_at_ms` integer NOT NULL,
	`shift_id` text,
	`type` text NOT NULL,
	`amount_delta` integer NOT NULL,
	`source_type` text NOT NULL,
	`source_id` text NOT NULL,
	`payment_id` text,
	`reason` text,
	`created_by_user_id` text NOT NULL,
	FOREIGN KEY (`payment_id`) REFERENCES `payments`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "chk_cash_moves_hlc_len" CHECK(length("cash_moves"."hlc") = 58),
	CONSTRAINT "chk_cash_moves_created_at_ms_int" CHECK(typeof("cash_moves"."created_at_ms") = 'integer'),
	CONSTRAINT "chk_cash_moves_amount_delta_int" CHECK(typeof("cash_moves"."amount_delta") = 'integer'),
	CONSTRAINT "chk_cash_moves_type" CHECK("cash_moves"."type" IN ('sale_cash_in', 'debt_payment_in', 'cash_in', 'sale_change_out', 'refund_cash_out', 'cash_out', 'encashment')),
	CONSTRAINT "chk_cash_moves_amount_sign" CHECK(("cash_moves"."type" IN ('sale_cash_in', 'debt_payment_in', 'cash_in') AND "cash_moves"."amount_delta" > 0) OR ("cash_moves"."type" IN ('sale_change_out', 'refund_cash_out', 'cash_out', 'encashment') AND "cash_moves"."amount_delta" < 0)),
	CONSTRAINT "chk_cash_moves_source_type" CHECK(length(trim("cash_moves"."source_type")) >= 1)
);--> statement-breakpoint
CREATE INDEX `idx_cash_moves_store_created` ON `cash_moves` (`organization_id`,`store_id`,`created_at_ms`);--> statement-breakpoint
CREATE INDEX `idx_cash_moves_terminal` ON `cash_moves` (`organization_id`,`store_id`,`device_id`,`created_at_ms`);--> statement-breakpoint
CREATE INDEX `idx_cash_moves_shift_created` ON `cash_moves` (`organization_id`,`store_id`,`shift_id`,`created_at_ms`);--> statement-breakpoint
CREATE INDEX `idx_cash_moves_source` ON `cash_moves` (`source_type`,`source_id`);--> statement-breakpoint
DROP TRIGGER IF EXISTS "trg_sales_no_delete";--> statement-breakpoint
CREATE TRIGGER "trg_sales_no_delete"
BEFORE DELETE ON "sales"
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'MONOTONE table "sales" forbids physical DELETE: use tombstone');
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
  NEW."completed_by_user_id" IS NOT OLD."completed_by_user_id" OR
  NEW."customer_id" IS NOT OLD."customer_id" OR
  NEW."shift_id" IS NOT OLD."shift_id" OR
  NEW."client_request_id" IS NOT OLD."client_request_id" OR
  NEW."request_hash" IS NOT OLD."request_hash" OR
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
DROP TRIGGER IF EXISTS "trg_cash_moves_no_update";--> statement-breakpoint
CREATE TRIGGER "trg_cash_moves_no_update"
BEFORE UPDATE ON "cash_moves"
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'FACT table "cash_moves" is immutable: UPDATE is forbidden');
END;--> statement-breakpoint
DROP TRIGGER IF EXISTS "trg_cash_moves_no_delete";--> statement-breakpoint
CREATE TRIGGER "trg_cash_moves_no_delete"
BEFORE DELETE ON "cash_moves"
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'FACT table "cash_moves" forbids physical DELETE: use tombstone');
END;
