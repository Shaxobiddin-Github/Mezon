CREATE TABLE `__tmp_cash_moves` AS SELECT * FROM `cash_moves`;--> statement-breakpoint
CREATE TABLE `__tmp_payments` AS SELECT * FROM `payments`;--> statement-breakpoint
CREATE TABLE `__tmp_sale_lines` AS SELECT * FROM `sale_lines`;--> statement-breakpoint
DROP TABLE `cash_moves`;--> statement-breakpoint
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
	`void_client_request_id` text,
	`void_request_hash` text,
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
	CONSTRAINT "chk_sales_void_pair" CHECK(("__new_sales"."voided_at_ms" IS NULL AND "__new_sales"."voided_by_user_id" IS NULL AND "__new_sales"."void_reason" IS NULL AND "__new_sales"."void_client_request_id" IS NULL AND "__new_sales"."void_request_hash" IS NULL) OR ("__new_sales"."voided_at_ms" IS NOT NULL AND "__new_sales"."voided_by_user_id" IS NOT NULL AND "__new_sales"."void_reason" IS NOT NULL AND length(trim("__new_sales"."void_reason")) >= 1 AND "__new_sales"."void_client_request_id" IS NOT NULL AND "__new_sales"."void_request_hash" IS NOT NULL AND length(trim("__new_sales"."void_request_hash")) >= 6))
);--> statement-breakpoint
INSERT INTO `__new_sales`("id", "organization_id", "store_id", "device_id", "hlc", "created_at_ms", "updated_at_ms", "receipt_no", "receipt_code", "source_cart_id", "cashier_user_id", "completed_by_user_id", "customer_id", "shift_id", "client_request_id", "request_hash", "subtotal_gross", "total_promo_discount", "subtotal_after_promo", "manual_discount_mode", "manual_discount_value", "manual_discount_reason", "order_discount_amount", "total_final", "total_net_ex_vat", "total_vat", "total_paid", "debt_amount", "change_amount", "override_approved_by_user_id", "override_approved_amount", "override_approved_at_ms", "voided_at_ms", "voided_by_user_id", "void_reason", "void_client_request_id", "void_request_hash") SELECT "id", "organization_id", "store_id", "device_id", "hlc", "created_at_ms", "updated_at_ms", "receipt_no", "receipt_code", "source_cart_id", "cashier_user_id", "completed_by_user_id", "customer_id", "shift_id", "client_request_id", "request_hash", "subtotal_gross", "total_promo_discount", "subtotal_after_promo", "manual_discount_mode", "manual_discount_value", "manual_discount_reason", "order_discount_amount", "total_final", "total_net_ex_vat", "total_vat", "total_paid", "debt_amount", "change_amount", "override_approved_by_user_id", "override_approved_amount", "override_approved_at_ms", "voided_at_ms", "voided_by_user_id", CASE WHEN "voided_at_ms" IS NOT NULL THEN COALESCE(NULLIF(trim("void_reason"), ''), 'legacy') ELSE NULL END, CASE WHEN "voided_at_ms" IS NOT NULL THEN "id" ELSE NULL END, CASE WHEN "voided_at_ms" IS NOT NULL THEN ('legacy:' || "id") ELSE NULL END FROM `sales`;--> statement-breakpoint
DROP TABLE `sales`;--> statement-breakpoint
ALTER TABLE `__new_sales` RENAME TO `sales`;--> statement-breakpoint
CREATE UNIQUE INDEX `uidx_sales_org_device_receipt_no` ON `sales` (`organization_id`,`device_id`,`receipt_no`);--> statement-breakpoint
CREATE UNIQUE INDEX `uidx_sales_org_client_request` ON `sales` (`organization_id`,`client_request_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `uidx_sales_org_void_client_req` ON `sales` (`organization_id`,`void_client_request_id`) WHERE "sales"."void_client_request_id" IS NOT NULL;--> statement-breakpoint
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
INSERT INTO `cash_moves`("id", "organization_id", "store_id", "device_id", "hlc", "created_at_ms", "shift_id", "type", "amount_delta", "source_type", "source_id", "payment_id", "reason", "created_by_user_id") SELECT "id", "organization_id", "store_id", "device_id", "hlc", "created_at_ms", "shift_id", "type", "amount_delta", "source_type", "source_id", "payment_id", "reason", "created_by_user_id" FROM `__tmp_cash_moves`;--> statement-breakpoint
DROP TABLE `__tmp_cash_moves`;--> statement-breakpoint
CREATE INDEX `idx_cash_moves_store_created` ON `cash_moves` (`organization_id`,`store_id`,`created_at_ms`);--> statement-breakpoint
CREATE INDEX `idx_cash_moves_terminal` ON `cash_moves` (`organization_id`,`store_id`,`device_id`,`created_at_ms`);--> statement-breakpoint
CREATE INDEX `idx_cash_moves_shift_created` ON `cash_moves` (`organization_id`,`store_id`,`shift_id`,`created_at_ms`);--> statement-breakpoint
CREATE INDEX `idx_cash_moves_source` ON `cash_moves` (`source_type`,`source_id`);--> statement-breakpoint
CREATE TABLE `returns` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`store_id` text NOT NULL,
	`device_id` text NOT NULL,
	`hlc` text NOT NULL,
	`created_at_ms` integer NOT NULL,
	`sale_id` text NOT NULL,
	`return_no` integer NOT NULL,
	`return_code` text NOT NULL,
	`processed_by_user_id` text NOT NULL,
	`override_approved_by_user_id` text,
	`override_approved_at_ms` integer,
	`reason` text NOT NULL,
	`client_request_id` text NOT NULL,
	`request_hash` text NOT NULL,
	`total_refund` integer NOT NULL,
	`total_net_ex_vat` integer NOT NULL,
	`total_vat` integer NOT NULL,
	`cash_refund_amount` integer NOT NULL,
	`non_cash_refund_amount` integer NOT NULL,
	`debt_offset_amount` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`sale_id`) REFERENCES `sales`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`processed_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`override_approved_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "chk_returns_hlc_len" CHECK(length("returns"."hlc") = 58),
	CONSTRAINT "chk_returns_created_at_ms_int" CHECK(typeof("returns"."created_at_ms") = 'integer'),
	CONSTRAINT "chk_returns_return_no_int" CHECK(typeof("returns"."return_no") = 'integer'),
	CONSTRAINT "chk_returns_override_approved_at_ms_int" CHECK("returns"."override_approved_at_ms" IS NULL OR typeof("returns"."override_approved_at_ms") = 'integer'),
	CONSTRAINT "chk_returns_total_refund_int" CHECK(typeof("returns"."total_refund") = 'integer'),
	CONSTRAINT "chk_returns_total_net_ex_vat_int" CHECK(typeof("returns"."total_net_ex_vat") = 'integer'),
	CONSTRAINT "chk_returns_total_vat_int" CHECK(typeof("returns"."total_vat") = 'integer'),
	CONSTRAINT "chk_returns_cash_refund_amount_int" CHECK(typeof("returns"."cash_refund_amount") = 'integer'),
	CONSTRAINT "chk_returns_non_cash_refund_amount_int" CHECK(typeof("returns"."non_cash_refund_amount") = 'integer'),
	CONSTRAINT "chk_returns_debt_offset_amount_int" CHECK(typeof("returns"."debt_offset_amount") = 'integer'),
	CONSTRAINT "chk_returns_return_no_pos" CHECK("returns"."return_no" >= 1),
	CONSTRAINT "chk_returns_code_nonempty" CHECK(length(trim("returns"."return_code")) >= 1),
	CONSTRAINT "chk_returns_reason_nonempty" CHECK(length(trim("returns"."reason")) >= 1),
	CONSTRAINT "chk_returns_request_hash_nonempty" CHECK(length(trim("returns"."request_hash")) >= 6),
	CONSTRAINT "chk_returns_money_nonneg" CHECK("returns"."total_refund" >= 0 AND "returns"."total_net_ex_vat" >= 0 AND "returns"."total_vat" >= 0 AND "returns"."cash_refund_amount" >= 0 AND "returns"."non_cash_refund_amount" >= 0 AND "returns"."debt_offset_amount" >= 0),
	CONSTRAINT "chk_returns_totals_balance" CHECK("returns"."cash_refund_amount" + "returns"."non_cash_refund_amount" + "returns"."debt_offset_amount" = "returns"."total_refund" AND "returns"."total_net_ex_vat" + "returns"."total_vat" = "returns"."total_refund"),
	CONSTRAINT "chk_returns_override_pair" CHECK(("returns"."override_approved_by_user_id" IS NULL AND "returns"."override_approved_at_ms" IS NULL) OR ("returns"."override_approved_by_user_id" IS NOT NULL AND "returns"."override_approved_at_ms" IS NOT NULL))
);--> statement-breakpoint
CREATE UNIQUE INDEX `uidx_returns_org_device_return_no` ON `returns` (`organization_id`,`device_id`,`return_no`);--> statement-breakpoint
CREATE UNIQUE INDEX `uidx_returns_org_client_request` ON `returns` (`organization_id`,`client_request_id`);--> statement-breakpoint
CREATE INDEX `idx_returns_store_sale` ON `returns` (`organization_id`,`store_id`,`sale_id`);--> statement-breakpoint
CREATE INDEX `idx_returns_store_created` ON `returns` (`organization_id`,`store_id`,`created_at_ms`);--> statement-breakpoint
CREATE TABLE `return_lines` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`store_id` text NOT NULL,
	`device_id` text NOT NULL,
	`hlc` text NOT NULL,
	`created_at_ms` integer NOT NULL,
	`return_id` text NOT NULL,
	`sale_id` text NOT NULL,
	`sale_line_id` text NOT NULL,
	`sort_order` integer NOT NULL,
	`line_kind` text NOT NULL,
	`product_id` text,
	`variant_id` text,
	`item_name` text NOT NULL,
	`unit` text NOT NULL,
	`qty` integer NOT NULL,
	`unit_price_snapshot` integer NOT NULL,
	`vat_rate_bp_snapshot` integer NOT NULL,
	`mxik_snapshot` text,
	`package_code_snapshot` text,
	`refund_amount` integer NOT NULL,
	`net_ex_vat` integer NOT NULL,
	`vat_total` integer NOT NULL,
	`cost_value` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`return_id`) REFERENCES `returns`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`sale_id`) REFERENCES `sales`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`sale_line_id`) REFERENCES `sale_lines`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`product_id`) REFERENCES `products`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`variant_id`) REFERENCES `product_variants`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "chk_return_lines_hlc_len" CHECK(length("return_lines"."hlc") = 58),
	CONSTRAINT "chk_return_lines_created_at_ms_int" CHECK(typeof("return_lines"."created_at_ms") = 'integer'),
	CONSTRAINT "chk_return_lines_qty_int" CHECK(typeof("return_lines"."qty") = 'integer'),
	CONSTRAINT "chk_return_lines_unit_price_snapshot_int" CHECK(typeof("return_lines"."unit_price_snapshot") = 'integer'),
	CONSTRAINT "chk_return_lines_refund_amount_int" CHECK(typeof("return_lines"."refund_amount") = 'integer'),
	CONSTRAINT "chk_return_lines_net_ex_vat_int" CHECK(typeof("return_lines"."net_ex_vat") = 'integer'),
	CONSTRAINT "chk_return_lines_vat_total_int" CHECK(typeof("return_lines"."vat_total") = 'integer'),
	CONSTRAINT "chk_return_lines_cost_value_int" CHECK(typeof("return_lines"."cost_value") = 'integer'),
	CONSTRAINT "chk_return_lines_sort_nonneg" CHECK("return_lines"."sort_order" >= 0),
	CONSTRAINT "chk_return_lines_kind" CHECK("return_lines"."line_kind" IN ('catalog', 'quick_sale')),
	CONSTRAINT "chk_return_lines_kind_product" CHECK(("return_lines"."line_kind" = 'catalog' AND "return_lines"."product_id" IS NOT NULL) OR ("return_lines"."line_kind" = 'quick_sale' AND "return_lines"."product_id" IS NULL AND "return_lines"."variant_id" IS NULL)),
	CONSTRAINT "chk_return_lines_name_nonempty" CHECK(length(trim("return_lines"."item_name")) >= 1),
	CONSTRAINT "chk_return_lines_unit" CHECK("return_lines"."unit" IN ('dona', 'kg', 'g', 'litr', 'metr', 'm2', 'qadoq')),
	CONSTRAINT "chk_return_lines_qty_pos" CHECK("return_lines"."qty" > 0),
	CONSTRAINT "chk_return_lines_unit_int" CHECK("return_lines"."unit" NOT IN ('dona', 'qadoq') OR ("return_lines"."qty" % 1000) = 0),
	CONSTRAINT "chk_return_lines_money_nonneg" CHECK("return_lines"."unit_price_snapshot" >= 0 AND "return_lines"."refund_amount" >= 0 AND "return_lines"."net_ex_vat" >= 0 AND "return_lines"."vat_total" >= 0 AND "return_lines"."cost_value" >= 0),
	CONSTRAINT "chk_return_lines_vat_bp" CHECK("return_lines"."vat_rate_bp_snapshot" >= 0 AND "return_lines"."vat_rate_bp_snapshot" <= 10000),
	CONSTRAINT "chk_return_lines_arithmetic" CHECK("return_lines"."net_ex_vat" + "return_lines"."vat_total" = "return_lines"."refund_amount")
);--> statement-breakpoint
CREATE UNIQUE INDEX `uidx_return_lines_return_sale_line` ON `return_lines` (`return_id`,`sale_line_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `uidx_return_lines_return_sort` ON `return_lines` (`return_id`,`sort_order`);--> statement-breakpoint
CREATE INDEX `idx_return_lines_sale_line` ON `return_lines` (`sale_line_id`);--> statement-breakpoint
CREATE INDEX `idx_return_lines_store_sale` ON `return_lines` (`organization_id`,`store_id`,`sale_id`);--> statement-breakpoint
CREATE TABLE `return_payments` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`store_id` text NOT NULL,
	`device_id` text NOT NULL,
	`hlc` text NOT NULL,
	`created_at_ms` integer NOT NULL,
	`return_id` text NOT NULL,
	`sale_id` text NOT NULL,
	`method` text NOT NULL,
	`amount` integer NOT NULL,
	`provider_ref` text,
	FOREIGN KEY (`return_id`) REFERENCES `returns`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`sale_id`) REFERENCES `sales`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "chk_return_payments_hlc_len" CHECK(length("return_payments"."hlc") = 58),
	CONSTRAINT "chk_return_payments_created_at_ms_int" CHECK(typeof("return_payments"."created_at_ms") = 'integer'),
	CONSTRAINT "chk_return_payments_amount_int" CHECK(typeof("return_payments"."amount") = 'integer'),
	CONSTRAINT "chk_return_payments_method" CHECK("return_payments"."method" IN ('cash', 'card', 'uzqr', 'payme', 'click', 'uzum', 'social_card', 'other')),
	CONSTRAINT "chk_return_payments_pos" CHECK("return_payments"."amount" > 0),
	CONSTRAINT "chk_return_payments_cash_no_ref" CHECK("return_payments"."method" <> 'cash' OR "return_payments"."provider_ref" IS NULL)
);--> statement-breakpoint
CREATE INDEX `idx_return_payments_return` ON `return_payments` (`return_id`);--> statement-breakpoint
CREATE INDEX `idx_return_payments_sale` ON `return_payments` (`sale_id`);--> statement-breakpoint
CREATE TABLE `__new_local_device_state` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`created_at_ms` integer NOT NULL,
	`updated_at_ms` integer NOT NULL,
	`device_id` text NOT NULL,
	`last_device_seq` integer NOT NULL,
	`last_receipt_seq` integer DEFAULT 0 NOT NULL,
	`last_return_seq` integer DEFAULT 0 NOT NULL,
	`last_hlc` text NOT NULL,
	`last_uuid_ms` integer NOT NULL,
	CONSTRAINT "chk_local_device_state_created_at_ms_int" CHECK(typeof("__new_local_device_state"."created_at_ms") = 'integer'),
	CONSTRAINT "chk_local_device_state_updated_at_ms_int" CHECK(typeof("__new_local_device_state"."updated_at_ms") = 'integer'),
	CONSTRAINT "chk_local_device_state_last_device_seq_int" CHECK(typeof("__new_local_device_state"."last_device_seq") = 'integer'),
	CONSTRAINT "chk_local_device_state_last_receipt_seq_int" CHECK(typeof("__new_local_device_state"."last_receipt_seq") = 'integer'),
	CONSTRAINT "chk_local_device_state_last_return_seq_int" CHECK(typeof("__new_local_device_state"."last_return_seq") = 'integer'),
	CONSTRAINT "chk_local_device_state_last_hlc_len" CHECK(length("__new_local_device_state"."last_hlc") = 58),
	CONSTRAINT "chk_local_device_state_last_uuid_ms_int" CHECK(typeof("__new_local_device_state"."last_uuid_ms") = 'integer'),
	CONSTRAINT "chk_local_device_state_seq_nonneg" CHECK("__new_local_device_state"."last_device_seq" >= 0),
	CONSTRAINT "chk_local_device_state_receipt_nonneg" CHECK("__new_local_device_state"."last_receipt_seq" >= 0),
	CONSTRAINT "chk_local_device_state_return_nonneg" CHECK("__new_local_device_state"."last_return_seq" >= 0)
);--> statement-breakpoint
INSERT INTO `__new_local_device_state`("id", "organization_id", "created_at_ms", "updated_at_ms", "device_id", "last_device_seq", "last_receipt_seq", "last_return_seq", "last_hlc", "last_uuid_ms") SELECT "id", "organization_id", "created_at_ms", "updated_at_ms", "device_id", "last_device_seq", "last_receipt_seq", 0, "last_hlc", "last_uuid_ms" FROM `local_device_state`;--> statement-breakpoint
DROP TABLE `local_device_state`;--> statement-breakpoint
ALTER TABLE `__new_local_device_state` RENAME TO `local_device_state`;--> statement-breakpoint
CREATE UNIQUE INDEX `uidx_local_device_state_device_id` ON `local_device_state` (`device_id`);--> statement-breakpoint
CREATE TABLE `__new_local_hub_config` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`created_at_ms` integer NOT NULL,
	`updated_at_ms` integer NOT NULL,
	`store_id` text NOT NULL,
	`device_id` text NOT NULL,
	`singleton_guard` integer NOT NULL,
	`setup_completed_at_ms` integer NOT NULL,
	`negative_stock_policy` text DEFAULT 'warn' NOT NULL,
	`cashier_discount_percent_unlimited` integer DEFAULT false NOT NULL,
	`cashier_max_discount_percent_bp` integer DEFAULT 0 NOT NULL,
	`cashier_discount_amount_unlimited` integer DEFAULT false NOT NULL,
	`cashier_max_discount_amount` integer DEFAULT 0 NOT NULL,
	`quick_sale_default_mxik` text,
	`quick_sale_default_vat_rate_bp` integer,
	`store_timezone` text DEFAULT 'Asia/Tashkent' NOT NULL,
	CONSTRAINT "chk_local_hub_config_created_at_ms_int" CHECK(typeof("__new_local_hub_config"."created_at_ms") = 'integer'),
	CONSTRAINT "chk_local_hub_config_updated_at_ms_int" CHECK(typeof("__new_local_hub_config"."updated_at_ms") = 'integer'),
	CONSTRAINT "chk_local_hub_config_setup_completed_at_ms_int" CHECK(typeof("__new_local_hub_config"."setup_completed_at_ms") = 'integer'),
	CONSTRAINT "chk_local_hub_config_cashier_max_discount_amount_int" CHECK(typeof("__new_local_hub_config"."cashier_max_discount_amount") = 'integer'),
	CONSTRAINT "chk_local_hub_config_singleton" CHECK("__new_local_hub_config"."singleton_guard" = 1),
	CONSTRAINT "chk_local_hub_config_neg_policy" CHECK("__new_local_hub_config"."negative_stock_policy" IN ('warn', 'block')),
	CONSTRAINT "chk_local_hub_config_pct_unlim" CHECK("__new_local_hub_config"."cashier_discount_percent_unlimited" IN (0, 1)),
	CONSTRAINT "chk_local_hub_config_max_pct" CHECK("__new_local_hub_config"."cashier_max_discount_percent_bp" >= 0 AND "__new_local_hub_config"."cashier_max_discount_percent_bp" <= 10000),
	CONSTRAINT "chk_local_hub_config_amt_unlim" CHECK("__new_local_hub_config"."cashier_discount_amount_unlimited" IN (0, 1)),
	CONSTRAINT "chk_local_hub_config_max_amt" CHECK("__new_local_hub_config"."cashier_max_discount_amount" >= 0),
	CONSTRAINT "chk_local_hub_config_qs_vat" CHECK("__new_local_hub_config"."quick_sale_default_vat_rate_bp" IS NULL OR ("__new_local_hub_config"."quick_sale_default_vat_rate_bp" >= 0 AND "__new_local_hub_config"."quick_sale_default_vat_rate_bp" <= 10000)),
	CONSTRAINT "chk_local_hub_config_timezone_nonempty" CHECK(length(trim("__new_local_hub_config"."store_timezone")) >= 1)
);--> statement-breakpoint
INSERT INTO `__new_local_hub_config`("id", "organization_id", "created_at_ms", "updated_at_ms", "store_id", "device_id", "singleton_guard", "setup_completed_at_ms", "negative_stock_policy", "cashier_discount_percent_unlimited", "cashier_max_discount_percent_bp", "cashier_discount_amount_unlimited", "cashier_max_discount_amount", "quick_sale_default_mxik", "quick_sale_default_vat_rate_bp", "store_timezone") SELECT "id", "organization_id", "created_at_ms", "updated_at_ms", "store_id", "device_id", "singleton_guard", "setup_completed_at_ms", "negative_stock_policy", "cashier_discount_percent_unlimited", "cashier_max_discount_percent_bp", "cashier_discount_amount_unlimited", "cashier_max_discount_amount", "quick_sale_default_mxik", "quick_sale_default_vat_rate_bp", 'Asia/Tashkent' FROM `local_hub_config`;--> statement-breakpoint
DROP TABLE `local_hub_config`;--> statement-breakpoint
ALTER TABLE `__new_local_hub_config` RENAME TO `local_hub_config`;--> statement-breakpoint
CREATE UNIQUE INDEX `uidx_local_hub_config_singleton` ON `local_hub_config` (`singleton_guard`);--> statement-breakpoint
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
  OLD."voided_at_ms" IS NULL AND (
  NEW."voided_at_ms" IS NULL OR
  NEW."voided_by_user_id" IS NULL OR
  NEW."void_reason" IS NULL OR
  length(trim(NEW."void_reason")) = 0 OR
  NEW."void_client_request_id" IS NULL OR
  NEW."void_request_hash" IS NULL OR
  length(trim(NEW."void_request_hash")) < 6 OR
  OLD."voided_by_user_id" IS NOT NULL OR
  OLD."void_reason" IS NOT NULL OR
  OLD."void_client_request_id" IS NOT NULL OR
  OLD."void_request_hash" IS NOT NULL OR
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
  NEW."created_at_ms" IS NOT OLD."created_at_ms")
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
END;--> statement-breakpoint
DROP TRIGGER IF EXISTS "trg_returns_no_update";--> statement-breakpoint
CREATE TRIGGER "trg_returns_no_update"
BEFORE UPDATE ON "returns"
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'FACT table "returns" is immutable: UPDATE is forbidden');
END;--> statement-breakpoint
DROP TRIGGER IF EXISTS "trg_returns_no_delete";--> statement-breakpoint
CREATE TRIGGER "trg_returns_no_delete"
BEFORE DELETE ON "returns"
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'FACT table "returns" forbids physical DELETE: use tombstone');
END;--> statement-breakpoint
DROP TRIGGER IF EXISTS "trg_return_lines_no_update";--> statement-breakpoint
CREATE TRIGGER "trg_return_lines_no_update"
BEFORE UPDATE ON "return_lines"
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'FACT table "return_lines" is immutable: UPDATE is forbidden');
END;--> statement-breakpoint
DROP TRIGGER IF EXISTS "trg_return_lines_no_delete";--> statement-breakpoint
CREATE TRIGGER "trg_return_lines_no_delete"
BEFORE DELETE ON "return_lines"
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'FACT table "return_lines" forbids physical DELETE: use tombstone');
END;--> statement-breakpoint
DROP TRIGGER IF EXISTS "trg_return_payments_no_update";--> statement-breakpoint
CREATE TRIGGER "trg_return_payments_no_update"
BEFORE UPDATE ON "return_payments"
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'FACT table "return_payments" is immutable: UPDATE is forbidden');
END;--> statement-breakpoint
DROP TRIGGER IF EXISTS "trg_return_payments_no_delete";--> statement-breakpoint
CREATE TRIGGER "trg_return_payments_no_delete"
BEFORE DELETE ON "return_payments"
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'FACT table "return_payments" forbids physical DELETE: use tombstone');
END;--> statement-breakpoint
DROP VIEW IF EXISTS "v_sales_lines";--> statement-breakpoint
CREATE VIEW "v_sales_lines" AS
SELECT
  sl."organization_id" AS "organization_id",
  sl."store_id" AS "store_id",
  sl."device_id" AS "device_id",
  'sale' AS "record_kind",
  s."created_at_ms" AS "event_at_ms",
  s."id" AS "document_id",
  s."id" AS "sale_id",
  sl."id" AS "sale_line_id",
  NULL AS "return_id",
  sl."line_kind" AS "line_kind",
  sl."product_id" AS "product_id",
  sl."variant_id" AS "variant_id",
  sl."category_id_snapshot" AS "category_id_snapshot",
  sl."item_name" AS "item_name",
  sl."unit" AS "unit",
  1 AS "sign",
  sl."qty" AS "signed_qty",
  sl."final_total" AS "signed_final_total",
  sl."net_ex_vat" AS "signed_net_ex_vat",
  sl."vat_total" AS "signed_vat_total",
  sl."cost_value" AS "signed_cost_value"
FROM "sale_lines" sl
INNER JOIN "sales" s ON s."id" = sl."sale_id"
WHERE s."voided_at_ms" IS NULL
UNION ALL
SELECT
  rl."organization_id" AS "organization_id",
  rl."store_id" AS "store_id",
  rl."device_id" AS "device_id",
  'return' AS "record_kind",
  r."created_at_ms" AS "event_at_ms",
  r."id" AS "document_id",
  rl."sale_id" AS "sale_id",
  rl."sale_line_id" AS "sale_line_id",
  rl."return_id" AS "return_id",
  rl."line_kind" AS "line_kind",
  rl."product_id" AS "product_id",
  rl."variant_id" AS "variant_id",
  sl."category_id_snapshot" AS "category_id_snapshot",
  rl."item_name" AS "item_name",
  rl."unit" AS "unit",
  -1 AS "sign",
  -rl."qty" AS "signed_qty",
  -rl."refund_amount" AS "signed_final_total",
  -rl."net_ex_vat" AS "signed_net_ex_vat",
  -rl."vat_total" AS "signed_vat_total",
  -rl."cost_value" AS "signed_cost_value"
FROM "return_lines" rl
INNER JOIN "returns" r ON r."id" = rl."return_id"
INNER JOIN "sale_lines" sl ON sl."id" = rl."sale_line_id";
