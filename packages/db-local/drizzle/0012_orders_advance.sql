CREATE TABLE `orders` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`store_id` text NOT NULL,
	`device_id` text NOT NULL,
	`hlc` text NOT NULL,
	`created_at_ms` integer NOT NULL,
	`updated_at_ms` integer NOT NULL,
	`origin_device_id` text NOT NULL,
	`order_no` integer NOT NULL,
	`order_code` text NOT NULL,
	`status` text NOT NULL,
	`customer_id` text,
	`customer_name` text NOT NULL,
	`customer_phone_normalized` text,
	`due_at_ms` integer,
	`note` text,
	`subtotal_gross` integer NOT NULL,
	`total_promo_discount` integer NOT NULL,
	`subtotal_after_promo` integer NOT NULL,
	`manual_discount_mode` text NOT NULL,
	`manual_discount_value` integer NOT NULL,
	`manual_discount_reason` text,
	`order_discount_amount` integer NOT NULL,
	`total_amount` integer NOT NULL,
	`total_net_ex_vat` integer NOT NULL,
	`total_vat` integer NOT NULL,
	`override_approved_by_user_id` text,
	`override_approved_amount` integer,
	`created_by_user_id` text NOT NULL,
	`confirmed_at_ms` integer,
	`ready_at_ms` integer,
	`delivered_at_ms` integer,
	`delivered_sale_id` text,
	`cancelled_at_ms` integer,
	`cancelled_by_user_id` text,
	`cancel_reason` text,
	`create_client_request_id` text NOT NULL,
	`create_request_hash` text NOT NULL,
	`confirm_client_request_id` text,
	`confirm_request_hash` text,
	`ready_client_request_id` text,
	`ready_request_hash` text,
	`deliver_client_request_id` text,
	`deliver_request_hash` text,
	`cancel_client_request_id` text,
	`cancel_request_hash` text,
	FOREIGN KEY (`customer_id`) REFERENCES `customers`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`override_approved_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`delivered_sale_id`) REFERENCES `sales`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`cancelled_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "chk_orders_hlc_len" CHECK(length("orders"."hlc") = 58),
	CONSTRAINT "chk_orders_created_at_ms_int" CHECK(typeof("orders"."created_at_ms") = 'integer'),
	CONSTRAINT "chk_orders_updated_at_ms_int" CHECK(typeof("orders"."updated_at_ms") = 'integer'),
	CONSTRAINT "chk_orders_order_no_int" CHECK(typeof("orders"."order_no") = 'integer'),
	CONSTRAINT "chk_orders_due_at_ms_int" CHECK("orders"."due_at_ms" IS NULL OR typeof("orders"."due_at_ms") = 'integer'),
	CONSTRAINT "chk_orders_subtotal_gross_int" CHECK(typeof("orders"."subtotal_gross") = 'integer'),
	CONSTRAINT "chk_orders_total_promo_discount_int" CHECK(typeof("orders"."total_promo_discount") = 'integer'),
	CONSTRAINT "chk_orders_subtotal_after_promo_int" CHECK(typeof("orders"."subtotal_after_promo") = 'integer'),
	CONSTRAINT "chk_orders_manual_discount_value_int" CHECK(typeof("orders"."manual_discount_value") = 'integer'),
	CONSTRAINT "chk_orders_order_discount_amount_int" CHECK(typeof("orders"."order_discount_amount") = 'integer'),
	CONSTRAINT "chk_orders_total_amount_int" CHECK(typeof("orders"."total_amount") = 'integer'),
	CONSTRAINT "chk_orders_total_net_ex_vat_int" CHECK(typeof("orders"."total_net_ex_vat") = 'integer'),
	CONSTRAINT "chk_orders_total_vat_int" CHECK(typeof("orders"."total_vat") = 'integer'),
	CONSTRAINT "chk_orders_override_approved_amount_int" CHECK("orders"."override_approved_amount" IS NULL OR typeof("orders"."override_approved_amount") = 'integer'),
	CONSTRAINT "chk_orders_confirmed_at_ms_int" CHECK("orders"."confirmed_at_ms" IS NULL OR typeof("orders"."confirmed_at_ms") = 'integer'),
	CONSTRAINT "chk_orders_ready_at_ms_int" CHECK("orders"."ready_at_ms" IS NULL OR typeof("orders"."ready_at_ms") = 'integer'),
	CONSTRAINT "chk_orders_delivered_at_ms_int" CHECK("orders"."delivered_at_ms" IS NULL OR typeof("orders"."delivered_at_ms") = 'integer'),
	CONSTRAINT "chk_orders_cancelled_at_ms_int" CHECK("orders"."cancelled_at_ms" IS NULL OR typeof("orders"."cancelled_at_ms") = 'integer'),
	CONSTRAINT "chk_orders_no_pos" CHECK("orders"."order_no" >= 1),
	CONSTRAINT "chk_orders_code_nonempty" CHECK(length(trim("orders"."order_code")) >= 1),
	CONSTRAINT "chk_orders_status" CHECK("orders"."status" IN ('draft', 'confirmed', 'ready', 'delivered', 'cancelled')),
	CONSTRAINT "chk_orders_cust_name_nonempty" CHECK(length(trim("orders"."customer_name")) >= 1),
	CONSTRAINT "chk_orders_create_req_hash" CHECK(length(trim("orders"."create_request_hash")) >= 6),
	CONSTRAINT "chk_orders_disc_mode" CHECK("orders"."manual_discount_mode" IN ('none', 'percent', 'amount')),
	CONSTRAINT "chk_orders_disc_val" CHECK(("orders"."manual_discount_mode" = 'none' AND "orders"."manual_discount_value" = 0) OR ("orders"."manual_discount_mode" = 'percent' AND "orders"."manual_discount_value" BETWEEN 1 AND 10000) OR ("orders"."manual_discount_mode" = 'amount' AND "orders"."manual_discount_value" > 0)),
	CONSTRAINT "chk_orders_money_nonneg" CHECK("orders"."subtotal_gross" >= 0 AND "orders"."total_promo_discount" >= 0 AND "orders"."subtotal_after_promo" >= 0 AND "orders"."order_discount_amount" >= 0 AND "orders"."total_amount" >= 0 AND "orders"."total_net_ex_vat" >= 0 AND "orders"."total_vat" >= 0),
	CONSTRAINT "chk_orders_totals_balance" CHECK("orders"."total_net_ex_vat" + "orders"."total_vat" = "orders"."total_amount"),
	CONSTRAINT "chk_orders_override_pair" CHECK(("orders"."override_approved_by_user_id" IS NULL AND "orders"."override_approved_amount" IS NULL) OR ("orders"."override_approved_by_user_id" IS NOT NULL AND "orders"."override_approved_amount" >= 0)),
	CONSTRAINT "chk_orders_delivered_pair" CHECK(("orders"."status" <> 'delivered' AND "orders"."delivered_at_ms" IS NULL AND "orders"."delivered_sale_id" IS NULL) OR ("orders"."status" = 'delivered' AND "orders"."delivered_at_ms" IS NOT NULL AND "orders"."delivered_sale_id" IS NOT NULL)),
	CONSTRAINT "chk_orders_cancelled_pair" CHECK(("orders"."status" <> 'cancelled' AND "orders"."cancelled_at_ms" IS NULL AND "orders"."cancelled_by_user_id" IS NULL AND "orders"."cancel_reason" IS NULL) OR ("orders"."status" = 'cancelled' AND "orders"."cancelled_at_ms" IS NOT NULL AND "orders"."cancelled_by_user_id" IS NOT NULL AND "orders"."cancel_reason" IS NOT NULL AND length(trim("orders"."cancel_reason")) >= 1))
);--> statement-breakpoint
CREATE UNIQUE INDEX `uidx_orders_org_origin_device_no` ON `orders` (`organization_id`,`origin_device_id`,`order_no`);--> statement-breakpoint
CREATE UNIQUE INDEX `uidx_orders_org_create_req` ON `orders` (`organization_id`,`create_client_request_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `uidx_orders_org_confirm_req` ON `orders` (`organization_id`,`confirm_client_request_id`) WHERE "orders"."confirm_client_request_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `uidx_orders_org_ready_req` ON `orders` (`organization_id`,`ready_client_request_id`) WHERE "orders"."ready_client_request_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `uidx_orders_org_deliver_req` ON `orders` (`organization_id`,`deliver_client_request_id`) WHERE "orders"."deliver_client_request_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `uidx_orders_org_cancel_req` ON `orders` (`organization_id`,`cancel_client_request_id`) WHERE "orders"."cancel_client_request_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX `idx_orders_store_status_created` ON `orders` (`organization_id`,`store_id`,`status`,`created_at_ms`);--> statement-breakpoint
CREATE INDEX `idx_orders_store_customer` ON `orders` (`organization_id`,`store_id`,`customer_id`,`created_at_ms`);--> statement-breakpoint
CREATE TABLE `order_lines` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`store_id` text NOT NULL,
	`device_id` text NOT NULL,
	`hlc` text NOT NULL,
	`created_at_ms` integer NOT NULL,
	`order_id` text NOT NULL,
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
	FOREIGN KEY (`order_id`) REFERENCES `orders`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`product_id`) REFERENCES `products`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`variant_id`) REFERENCES `product_variants`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "chk_order_lines_hlc_len" CHECK(length("order_lines"."hlc") = 58),
	CONSTRAINT "chk_order_lines_created_at_ms_int" CHECK(typeof("order_lines"."created_at_ms") = 'integer'),
	CONSTRAINT "chk_order_lines_qty_int" CHECK(typeof("order_lines"."qty") = 'integer'),
	CONSTRAINT "chk_order_lines_unit_price_snapshot_int" CHECK(typeof("order_lines"."unit_price_snapshot") = 'integer'),
	CONSTRAINT "chk_order_lines_free_units_int" CHECK(typeof("order_lines"."free_units") = 'integer'),
	CONSTRAINT "chk_order_lines_gross_total_int" CHECK(typeof("order_lines"."gross_total") = 'integer'),
	CONSTRAINT "chk_order_lines_promo_discount_int" CHECK(typeof("order_lines"."promo_discount") = 'integer'),
	CONSTRAINT "chk_order_lines_subtotal_after_promo_int" CHECK(typeof("order_lines"."subtotal_after_promo") = 'integer'),
	CONSTRAINT "chk_order_lines_allocated_order_discount_int" CHECK(typeof("order_lines"."allocated_order_discount") = 'integer'),
	CONSTRAINT "chk_order_lines_final_total_int" CHECK(typeof("order_lines"."final_total") = 'integer'),
	CONSTRAINT "chk_order_lines_net_ex_vat_int" CHECK(typeof("order_lines"."net_ex_vat") = 'integer'),
	CONSTRAINT "chk_order_lines_vat_total_int" CHECK(typeof("order_lines"."vat_total") = 'integer'),
	CONSTRAINT "chk_order_lines_sort_nonneg" CHECK("order_lines"."sort_order" >= 0),
	CONSTRAINT "chk_order_lines_kind" CHECK("order_lines"."line_kind" IN ('catalog', 'quick_sale')),
	CONSTRAINT "chk_order_lines_kind_product" CHECK(("order_lines"."line_kind" = 'catalog' AND "order_lines"."product_id" IS NOT NULL) OR ("order_lines"."line_kind" = 'quick_sale' AND "order_lines"."product_id" IS NULL AND "order_lines"."variant_id" IS NULL)),
	CONSTRAINT "chk_order_lines_name_nonempty" CHECK(length(trim("order_lines"."item_name")) >= 1),
	CONSTRAINT "chk_order_lines_unit" CHECK("order_lines"."unit" IN ('dona', 'kg', 'g', 'litr', 'metr', 'm2', 'qadoq')),
	CONSTRAINT "chk_order_lines_qty_pos" CHECK("order_lines"."qty" > 0),
	CONSTRAINT "chk_order_lines_unit_int" CHECK("order_lines"."unit" NOT IN ('dona', 'qadoq') OR ("order_lines"."qty" % 1000) = 0),
	CONSTRAINT "chk_order_lines_money_nonneg" CHECK("order_lines"."unit_price_snapshot" >= 0 AND "order_lines"."free_units" >= 0 AND "order_lines"."gross_total" >= 0 AND "order_lines"."promo_discount" >= 0 AND "order_lines"."subtotal_after_promo" >= 0 AND "order_lines"."allocated_order_discount" >= 0 AND "order_lines"."final_total" >= 0 AND "order_lines"."net_ex_vat" >= 0 AND "order_lines"."vat_total" >= 0),
	CONSTRAINT "chk_order_lines_vat_bp" CHECK("order_lines"."vat_rate_bp_snapshot" >= 0 AND "order_lines"."vat_rate_bp_snapshot" <= 10000),
	CONSTRAINT "chk_order_lines_arithmetic" CHECK("order_lines"."subtotal_after_promo" = "order_lines"."gross_total" - "order_lines"."promo_discount" AND "order_lines"."final_total" = "order_lines"."subtotal_after_promo" - "order_lines"."allocated_order_discount" AND "order_lines"."net_ex_vat" + "order_lines"."vat_total" = "order_lines"."final_total")
);--> statement-breakpoint
CREATE UNIQUE INDEX `uidx_order_lines_order_sort` ON `order_lines` (`order_id`,`sort_order`);--> statement-breakpoint
CREATE INDEX `idx_order_lines_store_order` ON `order_lines` (`organization_id`,`store_id`,`order_id`);--> statement-breakpoint
CREATE TABLE `order_payments` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`store_id` text NOT NULL,
	`device_id` text NOT NULL,
	`hlc` text NOT NULL,
	`created_at_ms` integer NOT NULL,
	`order_id` text NOT NULL,
	`shift_id` text NOT NULL,
	`shift_cashier_session_id` text NOT NULL,
	`kind` text NOT NULL,
	`method` text NOT NULL,
	`amount` integer NOT NULL,
	`tendered_amount` integer,
	`change_amount` integer DEFAULT 0 NOT NULL,
	`provider_ref` text,
	`reason` text,
	`created_by_user_id` text NOT NULL,
	`override_approved_by_user_id` text,
	`seq` integer DEFAULT 0 NOT NULL,
	`client_request_id` text NOT NULL,
	`request_hash` text NOT NULL,
	FOREIGN KEY (`order_id`) REFERENCES `orders`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`shift_id`) REFERENCES `shifts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`shift_cashier_session_id`) REFERENCES `shift_cashier_sessions`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`override_approved_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "chk_order_payments_hlc_len" CHECK(length("order_payments"."hlc") = 58),
	CONSTRAINT "chk_order_payments_created_at_ms_int" CHECK(typeof("order_payments"."created_at_ms") = 'integer'),
	CONSTRAINT "chk_order_payments_amount_int" CHECK(typeof("order_payments"."amount") = 'integer'),
	CONSTRAINT "chk_order_payments_tendered_amount_int" CHECK("order_payments"."tendered_amount" IS NULL OR typeof("order_payments"."tendered_amount") = 'integer'),
	CONSTRAINT "chk_order_payments_change_amount_int" CHECK(typeof("order_payments"."change_amount") = 'integer'),
	CONSTRAINT "chk_order_payments_seq_nonneg" CHECK("order_payments"."seq" >= 0),
	CONSTRAINT "chk_order_payments_kind" CHECK("order_payments"."kind" IN ('advance', 'advance_refund')),
	CONSTRAINT "chk_order_payments_method" CHECK("order_payments"."method" IN ('cash', 'card', 'uzqr', 'payme', 'click', 'uzum', 'social_card', 'other')),
	CONSTRAINT "chk_order_payments_amt_pos" CHECK("order_payments"."amount" > 0 AND "order_payments"."change_amount" >= 0),
	CONSTRAINT "chk_order_payments_req_hash" CHECK(length(trim("order_payments"."request_hash")) >= 6),
	CONSTRAINT "chk_order_payments_cash_pair" CHECK(("order_payments"."kind" = 'advance' AND "order_payments"."method" = 'cash' AND "order_payments"."tendered_amount" IS NOT NULL AND "order_payments"."tendered_amount" >= "order_payments"."amount" AND "order_payments"."tendered_amount" - "order_payments"."change_amount" = "order_payments"."amount") OR (("order_payments"."kind" <> 'advance' OR "order_payments"."method" <> 'cash') AND "order_payments"."tendered_amount" IS NULL AND "order_payments"."change_amount" = 0)),
	CONSTRAINT "chk_order_payments_refund_reason" CHECK("order_payments"."kind" <> 'advance_refund' OR ("order_payments"."reason" IS NOT NULL AND length(trim("order_payments"."reason")) >= 1))
);--> statement-breakpoint
CREATE UNIQUE INDEX `uidx_order_payments_org_req_seq` ON `order_payments` (`organization_id`,`client_request_id`,`seq`);--> statement-breakpoint
CREATE INDEX `idx_order_payments_order` ON `order_payments` (`order_id`,`created_at_ms`,`id`);--> statement-breakpoint
CREATE INDEX `idx_order_payments_shift` ON `order_payments` (`shift_id`,`created_at_ms`,`id`);--> statement-breakpoint
CREATE INDEX `idx_order_payments_store_kind` ON `order_payments` (`organization_id`,`store_id`,`kind`);--> statement-breakpoint
CREATE TABLE `__tmp_customer_ledger` AS SELECT * FROM `customer_ledger`;--> statement-breakpoint
DROP TABLE `customer_ledger`;--> statement-breakpoint
CREATE TABLE `__tmp_supplier_ledger` AS SELECT * FROM `supplier_ledger`;--> statement-breakpoint
DROP TABLE `supplier_ledger`;--> statement-breakpoint
CREATE TABLE `__tmp_cash_moves` AS SELECT * FROM `cash_moves`;--> statement-breakpoint
DROP TABLE `cash_moves`;--> statement-breakpoint
CREATE TABLE `__new_payments` (
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
	CONSTRAINT "chk_payments_hlc_len" CHECK(length("__new_payments"."hlc") = 58),
	CONSTRAINT "chk_payments_created_at_ms_int" CHECK(typeof("__new_payments"."created_at_ms") = 'integer'),
	CONSTRAINT "chk_payments_amount_int" CHECK(typeof("__new_payments"."amount") = 'integer'),
	CONSTRAINT "chk_payments_tendered_amount_int" CHECK("__new_payments"."tendered_amount" IS NULL OR typeof("__new_payments"."tendered_amount") = 'integer'),
	CONSTRAINT "chk_payments_change_amount_int" CHECK(typeof("__new_payments"."change_amount") = 'integer'),
	CONSTRAINT "chk_payments_method" CHECK("__new_payments"."method" IN ('cash', 'card', 'uzqr', 'payme', 'click', 'uzum', 'social_card', 'other', 'advance')),
	CONSTRAINT "chk_payments_nonneg" CHECK("__new_payments"."amount" > 0 AND "__new_payments"."change_amount" >= 0),
	CONSTRAINT "chk_payments_cash_balance" CHECK(("__new_payments"."method" = 'cash' AND "__new_payments"."tendered_amount" IS NOT NULL AND "__new_payments"."tendered_amount" > 0 AND "__new_payments"."tendered_amount" >= "__new_payments"."amount" AND "__new_payments"."tendered_amount" - "__new_payments"."change_amount" = "__new_payments"."amount") OR ("__new_payments"."method" <> 'cash' AND "__new_payments"."tendered_amount" IS NULL AND "__new_payments"."change_amount" = 0))
);--> statement-breakpoint
INSERT INTO `__new_payments`("id", "organization_id", "store_id", "device_id", "hlc", "created_at_ms", "sale_id", "method", "amount", "tendered_amount", "change_amount", "provider_ref", "provider_meta_json") SELECT "id", "organization_id", "store_id", "device_id", "hlc", "created_at_ms", "sale_id", "method", "amount", "tendered_amount", "change_amount", "provider_ref", "provider_meta_json" FROM `payments`;--> statement-breakpoint
DROP TABLE `payments`;--> statement-breakpoint
ALTER TABLE `__new_payments` RENAME TO `payments`;--> statement-breakpoint
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
	`shift_cashier_session_id` text,
	`expense_category` text,
	FOREIGN KEY (`payment_id`) REFERENCES `payments`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "chk_cash_moves_hlc_len" CHECK(length("cash_moves"."hlc") = 58),
	CONSTRAINT "chk_cash_moves_created_at_ms_int" CHECK(typeof("cash_moves"."created_at_ms") = 'integer'),
	CONSTRAINT "chk_cash_moves_amount_delta_int" CHECK(typeof("cash_moves"."amount_delta") = 'integer'),
	CONSTRAINT "chk_cash_moves_type" CHECK("cash_moves"."type" IN ('sale_cash_in', 'debt_payment_in', 'cash_in', 'advance_cash_in', 'sale_change_out', 'refund_cash_out', 'supplier_payment_out', 'cash_out', 'encashment', 'advance_change_out', 'advance_refund_out')),
	CONSTRAINT "chk_cash_moves_amount_sign" CHECK(("cash_moves"."type" IN ('sale_cash_in', 'debt_payment_in', 'cash_in', 'advance_cash_in') AND "cash_moves"."amount_delta" > 0) OR ("cash_moves"."type" IN ('sale_change_out', 'refund_cash_out', 'supplier_payment_out', 'cash_out', 'encashment', 'advance_change_out', 'advance_refund_out') AND "cash_moves"."amount_delta" < 0)),
	CONSTRAINT "chk_cash_moves_source_type" CHECK(length(trim("cash_moves"."source_type")) >= 1)
);--> statement-breakpoint
INSERT INTO `cash_moves`("id", "organization_id", "store_id", "device_id", "hlc", "created_at_ms", "shift_id", "type", "amount_delta", "source_type", "source_id", "payment_id", "reason", "created_by_user_id", "shift_cashier_session_id", "expense_category") SELECT "id", "organization_id", "store_id", "device_id", "hlc", "created_at_ms", "shift_id", "type", "amount_delta", "source_type", "source_id", "payment_id", "reason", "created_by_user_id", "shift_cashier_session_id", "expense_category" FROM `__tmp_cash_moves`;--> statement-breakpoint
DROP TABLE `__tmp_cash_moves`;--> statement-breakpoint
CREATE INDEX `idx_cash_moves_store_created` ON `cash_moves` (`organization_id`,`store_id`,`created_at_ms`);--> statement-breakpoint
CREATE INDEX `idx_cash_moves_terminal` ON `cash_moves` (`organization_id`,`store_id`,`device_id`,`created_at_ms`);--> statement-breakpoint
CREATE INDEX `idx_cash_moves_shift_created` ON `cash_moves` (`organization_id`,`store_id`,`shift_id`,`created_at_ms`);--> statement-breakpoint
CREATE INDEX `idx_cash_moves_session` ON `cash_moves` (`shift_cashier_session_id`);--> statement-breakpoint
CREATE INDEX `idx_cash_moves_source` ON `cash_moves` (`source_type`,`source_id`);--> statement-breakpoint
CREATE TABLE `customer_ledger` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`store_id` text NOT NULL,
	`device_id` text NOT NULL,
	`hlc` text NOT NULL,
	`created_at_ms` integer NOT NULL,
	`customer_id` text NOT NULL,
	`entry_type` text NOT NULL,
	`amount_delta` integer NOT NULL,
	`source_type` text NOT NULL,
	`source_id` text NOT NULL,
	`sale_id` text,
	`payment_method` text,
	`provider_ref` text,
	`cash_move_id` text,
	`due_at_ms` integer,
	`reason` text,
	`created_by_user_id` text NOT NULL,
	`override_approved_by_user_id` text,
	`client_request_id` text,
	`request_hash` text,
	FOREIGN KEY (`customer_id`) REFERENCES `customers`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`sale_id`) REFERENCES `sales`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`cash_move_id`) REFERENCES `cash_moves`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`override_approved_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "chk_customer_ledger_hlc_len" CHECK(length("customer_ledger"."hlc") = 58),
	CONSTRAINT "chk_customer_ledger_created_at_ms_int" CHECK(typeof("customer_ledger"."created_at_ms") = 'integer'),
	CONSTRAINT "chk_customer_ledger_amount_delta_int" CHECK(typeof("customer_ledger"."amount_delta") = 'integer'),
	CONSTRAINT "chk_customer_ledger_due_at_ms_int" CHECK("customer_ledger"."due_at_ms" IS NULL OR typeof("customer_ledger"."due_at_ms") = 'integer'),
	CONSTRAINT "chk_customer_ledger_entry_type" CHECK("customer_ledger"."entry_type" IN ('opening_balance', 'sale_debt', 'debt_payment', 'return_offset', 'adjustment')),
	CONSTRAINT "chk_customer_ledger_source_type" CHECK("customer_ledger"."source_type" IN ('opening_balance', 'sale', 'debt_payment', 'sale_void', 'return', 'adjustment')),
	CONSTRAINT "chk_customer_ledger_delta_sign" CHECK(("customer_ledger"."entry_type" IN ('opening_balance', 'sale_debt') AND "customer_ledger"."amount_delta" > 0) OR ("customer_ledger"."entry_type" IN ('debt_payment', 'return_offset') AND "customer_ledger"."amount_delta" < 0) OR ("customer_ledger"."entry_type" = 'adjustment' AND "customer_ledger"."amount_delta" <> 0)),
	CONSTRAINT "chk_customer_ledger_payment_fields" CHECK(("customer_ledger"."entry_type" = 'debt_payment' AND "customer_ledger"."payment_method" IN ('cash', 'card', 'uzqr', 'payme', 'click', 'uzum', 'social_card', 'other') AND (("customer_ledger"."payment_method" = 'cash' AND "customer_ledger"."cash_move_id" IS NOT NULL AND "customer_ledger"."provider_ref" IS NULL) OR ("customer_ledger"."payment_method" <> 'cash' AND "customer_ledger"."cash_move_id" IS NULL))) OR ("customer_ledger"."entry_type" <> 'debt_payment' AND "customer_ledger"."payment_method" IS NULL AND "customer_ledger"."provider_ref" IS NULL AND "customer_ledger"."cash_move_id" IS NULL)),
	CONSTRAINT "chk_customer_ledger_sale_ref" CHECK(("customer_ledger"."entry_type" IN ('sale_debt', 'return_offset') AND "customer_ledger"."sale_id" IS NOT NULL) OR ("customer_ledger"."entry_type" IN ('opening_balance', 'debt_payment', 'adjustment'))),
	CONSTRAINT "chk_customer_ledger_reason_req" CHECK("customer_ledger"."entry_type" NOT IN ('opening_balance', 'adjustment') OR ("customer_ledger"."reason" IS NOT NULL AND length(trim("customer_ledger"."reason")) >= 1)),
	CONSTRAINT "chk_customer_ledger_req_pair" CHECK(("customer_ledger"."client_request_id" IS NULL AND "customer_ledger"."request_hash" IS NULL) OR ("customer_ledger"."client_request_id" IS NOT NULL AND "customer_ledger"."request_hash" IS NOT NULL AND length(trim("customer_ledger"."request_hash")) >= 6))
);--> statement-breakpoint
INSERT INTO `customer_ledger` SELECT * FROM `__tmp_customer_ledger`;--> statement-breakpoint
DROP TABLE `__tmp_customer_ledger`;--> statement-breakpoint
CREATE UNIQUE INDEX `uidx_customer_ledger_opening_balance` ON `customer_ledger` (`organization_id`,`customer_id`) WHERE "customer_ledger"."entry_type" = 'opening_balance';--> statement-breakpoint
CREATE UNIQUE INDEX `uidx_customer_ledger_org_client_req` ON `customer_ledger` (`organization_id`,`client_request_id`) WHERE "customer_ledger"."client_request_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX `idx_customer_ledger_cust_hlc` ON `customer_ledger` (`organization_id`,`customer_id`,`hlc`,`id`);--> statement-breakpoint
CREATE INDEX `idx_customer_ledger_cust_created` ON `customer_ledger` (`organization_id`,`customer_id`,`created_at_ms`,`id`);--> statement-breakpoint
CREATE INDEX `idx_customer_ledger_sale` ON `customer_ledger` (`sale_id`) WHERE "customer_ledger"."sale_id" IS NOT NULL;--> statement-breakpoint
CREATE TABLE `supplier_ledger` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`store_id` text NOT NULL,
	`device_id` text NOT NULL,
	`hlc` text NOT NULL,
	`created_at_ms` integer NOT NULL,
	`supplier_id` text NOT NULL,
	`entry_type` text NOT NULL,
	`amount_delta` integer NOT NULL,
	`source_type` text NOT NULL,
	`source_id` text NOT NULL,
	`receiving_id` text,
	`supplier_return_id` text,
	`payment_method` text,
	`provider_ref` text,
	`cash_move_id` text,
	`due_at_ms` integer,
	`reason` text,
	`created_by_user_id` text NOT NULL,
	`client_request_id` text,
	`request_hash` text,
	FOREIGN KEY (`supplier_id`) REFERENCES `suppliers`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`receiving_id`) REFERENCES `goods_receivings`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`supplier_return_id`) REFERENCES `supplier_returns`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`cash_move_id`) REFERENCES `cash_moves`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "chk_supplier_ledger_hlc_len" CHECK(length("supplier_ledger"."hlc") = 58),
	CONSTRAINT "chk_supplier_ledger_created_at_ms_int" CHECK(typeof("supplier_ledger"."created_at_ms") = 'integer'),
	CONSTRAINT "chk_supplier_ledger_amount_delta_int" CHECK(typeof("supplier_ledger"."amount_delta") = 'integer'),
	CONSTRAINT "chk_supplier_ledger_due_at_ms_int" CHECK("supplier_ledger"."due_at_ms" IS NULL OR typeof("supplier_ledger"."due_at_ms") = 'integer'),
	CONSTRAINT "chk_supplier_ledger_entry_type" CHECK("supplier_ledger"."entry_type" IN ('opening_balance', 'receiving_debt', 'supplier_payment', 'supplier_return', 'adjustment')),
	CONSTRAINT "chk_supplier_ledger_source_type" CHECK("supplier_ledger"."source_type" IN ('opening_balance', 'receiving', 'receiving_cost_confirm', 'supplier_payment', 'supplier_return', 'adjustment')),
	CONSTRAINT "chk_supplier_ledger_delta_sign" CHECK(("supplier_ledger"."entry_type" IN ('opening_balance', 'receiving_debt') AND "supplier_ledger"."amount_delta" > 0) OR ("supplier_ledger"."entry_type" IN ('supplier_payment', 'supplier_return') AND "supplier_ledger"."amount_delta" < 0) OR ("supplier_ledger"."entry_type" = 'adjustment' AND "supplier_ledger"."amount_delta" <> 0)),
	CONSTRAINT "chk_supplier_ledger_payment_fields" CHECK(("supplier_ledger"."entry_type" = 'supplier_payment' AND "supplier_ledger"."payment_method" IN ('cash', 'card', 'uzqr', 'payme', 'click', 'uzum', 'other') AND (("supplier_ledger"."payment_method" = 'cash' AND "supplier_ledger"."cash_move_id" IS NOT NULL AND "supplier_ledger"."provider_ref" IS NULL) OR ("supplier_ledger"."payment_method" <> 'cash' AND "supplier_ledger"."cash_move_id" IS NULL))) OR ("supplier_ledger"."entry_type" <> 'supplier_payment' AND "supplier_ledger"."payment_method" IS NULL AND "supplier_ledger"."provider_ref" IS NULL AND "supplier_ledger"."cash_move_id" IS NULL)),
	CONSTRAINT "chk_supplier_ledger_ref_consistency" CHECK(("supplier_ledger"."entry_type" = 'receiving_debt' AND "supplier_ledger"."receiving_id" IS NOT NULL) OR ("supplier_ledger"."entry_type" = 'supplier_return' AND "supplier_ledger"."supplier_return_id" IS NOT NULL) OR ("supplier_ledger"."entry_type" IN ('opening_balance', 'supplier_payment', 'adjustment'))),
	CONSTRAINT "chk_supplier_ledger_reason_req" CHECK("supplier_ledger"."entry_type" NOT IN ('opening_balance', 'adjustment') OR ("supplier_ledger"."reason" IS NOT NULL AND length(trim("supplier_ledger"."reason")) >= 1)),
	CONSTRAINT "chk_supplier_ledger_req_pair" CHECK(("supplier_ledger"."client_request_id" IS NULL AND "supplier_ledger"."request_hash" IS NULL) OR ("supplier_ledger"."client_request_id" IS NOT NULL AND "supplier_ledger"."request_hash" IS NOT NULL AND length(trim("supplier_ledger"."request_hash")) >= 6))
);--> statement-breakpoint
INSERT INTO `supplier_ledger` SELECT * FROM `__tmp_supplier_ledger`;--> statement-breakpoint
DROP TABLE `__tmp_supplier_ledger`;--> statement-breakpoint
CREATE UNIQUE INDEX `uidx_supplier_ledger_opening_balance` ON `supplier_ledger` (`organization_id`,`supplier_id`) WHERE "supplier_ledger"."entry_type" = 'opening_balance';--> statement-breakpoint
CREATE UNIQUE INDEX `uidx_supplier_ledger_org_client_req` ON `supplier_ledger` (`organization_id`,`client_request_id`) WHERE "supplier_ledger"."client_request_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX `idx_supplier_ledger_org_sup_hlc` ON `supplier_ledger` (`organization_id`,`supplier_id`,`hlc`,`id`);--> statement-breakpoint
CREATE INDEX `idx_supplier_ledger_receiving` ON `supplier_ledger` (`receiving_id`) WHERE "supplier_ledger"."receiving_id" IS NOT NULL;--> statement-breakpoint
CREATE TABLE `__tmp_shift_closure_method_totals` AS SELECT * FROM `shift_closure_method_totals`;--> statement-breakpoint
DROP TABLE `shift_closure_method_totals`;--> statement-breakpoint
CREATE TABLE `__tmp_shift_closure_cashiers` AS SELECT * FROM `shift_closure_cashiers`;--> statement-breakpoint
DROP TABLE `shift_closure_cashiers`;--> statement-breakpoint
CREATE TABLE `__new_shift_closures` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`store_id` text NOT NULL,
	`device_id` text NOT NULL,
	`hlc` text NOT NULL,
	`created_at_ms` integer NOT NULL,
	`shift_id` text NOT NULL,
	`closure_seq` integer NOT NULL,
	`is_reclose` integer DEFAULT false NOT NULL,
	`reason` text,
	`closed_by_user_id` text NOT NULL,
	`override_approved_by_user_id` text,
	`client_request_id` text NOT NULL,
	`request_hash` text NOT NULL,
	`expected_cash` integer NOT NULL,
	`counted_cash` integer NOT NULL,
	`discrepancy` integer NOT NULL,
	`denominations_json` text,
	`sales_count` integer NOT NULL,
	`returns_count` integer NOT NULL,
	`voids_count` integer NOT NULL,
	`gross_sales_total` integer NOT NULL,
	`returns_total` integer NOT NULL,
	`net_sales_total` integer NOT NULL,
	`order_advance_cash_total` integer DEFAULT 0 NOT NULL,
	`order_advance_non_cash_total` integer DEFAULT 0 NOT NULL,
	`order_advance_refund_total` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`shift_id`) REFERENCES `shifts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`closed_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`override_approved_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "chk_shift_closures_hlc_len" CHECK(length("__new_shift_closures"."hlc") = 58),
	CONSTRAINT "chk_shift_closures_created_at_ms_int" CHECK(typeof("__new_shift_closures"."created_at_ms") = 'integer'),
	CONSTRAINT "chk_shift_closures_expected_cash_int" CHECK(typeof("__new_shift_closures"."expected_cash") = 'integer'),
	CONSTRAINT "chk_shift_closures_counted_cash_int" CHECK(typeof("__new_shift_closures"."counted_cash") = 'integer'),
	CONSTRAINT "chk_shift_closures_discrepancy_int" CHECK(typeof("__new_shift_closures"."discrepancy") = 'integer'),
	CONSTRAINT "chk_shift_closures_gross_sales_total_int" CHECK(typeof("__new_shift_closures"."gross_sales_total") = 'integer'),
	CONSTRAINT "chk_shift_closures_returns_total_int" CHECK(typeof("__new_shift_closures"."returns_total") = 'integer'),
	CONSTRAINT "chk_shift_closures_net_sales_total_int" CHECK(typeof("__new_shift_closures"."net_sales_total") = 'integer'),
	CONSTRAINT "chk_shift_closures_order_advance_cash_total_int" CHECK(typeof("__new_shift_closures"."order_advance_cash_total") = 'integer'),
	CONSTRAINT "chk_shift_closures_order_advance_non_cash_total_int" CHECK(typeof("__new_shift_closures"."order_advance_non_cash_total") = 'integer'),
	CONSTRAINT "chk_shift_closures_order_advance_refund_total_int" CHECK(typeof("__new_shift_closures"."order_advance_refund_total") = 'integer'),
	CONSTRAINT "chk_shift_closures_seq_pos" CHECK("__new_shift_closures"."closure_seq" >= 1),
	CONSTRAINT "chk_shift_closures_reclose_bool" CHECK("__new_shift_closures"."is_reclose" IN (0, 1)),
	CONSTRAINT "chk_shift_closures_reclose_reason" CHECK("__new_shift_closures"."is_reclose" = 0 OR ("__new_shift_closures"."reason" IS NOT NULL AND length(trim("__new_shift_closures"."reason")) >= 1)),
	CONSTRAINT "chk_shift_closures_req_hash" CHECK(length(trim("__new_shift_closures"."request_hash")) >= 6),
	CONSTRAINT "chk_shift_closures_money_nonneg" CHECK("__new_shift_closures"."counted_cash" >= 0 AND "__new_shift_closures"."gross_sales_total" >= 0 AND "__new_shift_closures"."returns_total" >= 0 AND "__new_shift_closures"."order_advance_cash_total" >= 0 AND "__new_shift_closures"."order_advance_non_cash_total" >= 0 AND "__new_shift_closures"."order_advance_refund_total" >= 0),
	CONSTRAINT "chk_shift_closures_counts_nonneg" CHECK("__new_shift_closures"."sales_count" >= 0 AND "__new_shift_closures"."returns_count" >= 0 AND "__new_shift_closures"."voids_count" >= 0)
);--> statement-breakpoint
INSERT INTO `__new_shift_closures`("id", "organization_id", "store_id", "device_id", "hlc", "created_at_ms", "shift_id", "closure_seq", "is_reclose", "reason", "closed_by_user_id", "override_approved_by_user_id", "client_request_id", "request_hash", "expected_cash", "counted_cash", "discrepancy", "denominations_json", "sales_count", "returns_count", "voids_count", "gross_sales_total", "returns_total", "net_sales_total", "order_advance_cash_total", "order_advance_non_cash_total", "order_advance_refund_total") SELECT "id", "organization_id", "store_id", "device_id", "hlc", "created_at_ms", "shift_id", "closure_seq", "is_reclose", "reason", "closed_by_user_id", "override_approved_by_user_id", "client_request_id", "request_hash", "expected_cash", "counted_cash", "discrepancy", "denominations_json", "sales_count", "returns_count", "voids_count", "gross_sales_total", "returns_total", "net_sales_total", 0, 0, 0 FROM `shift_closures`;--> statement-breakpoint
DROP TABLE `shift_closures`;--> statement-breakpoint
ALTER TABLE `__new_shift_closures` RENAME TO `shift_closures`;--> statement-breakpoint
CREATE UNIQUE INDEX `uidx_shift_closures_shift_seq` ON `shift_closures` (`shift_id`,`closure_seq`);--> statement-breakpoint
CREATE UNIQUE INDEX `uidx_shift_closures_org_req` ON `shift_closures` (`organization_id`,`client_request_id`);--> statement-breakpoint
CREATE INDEX `idx_shift_closures_shift_seq` ON `shift_closures` (`shift_id`,`closure_seq`);--> statement-breakpoint
CREATE TABLE `shift_closure_method_totals` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`store_id` text NOT NULL,
	`device_id` text NOT NULL,
	`hlc` text NOT NULL,
	`created_at_ms` integer NOT NULL,
	`shift_closure_id` text NOT NULL,
	`method` text NOT NULL,
	`sales_amount` integer NOT NULL,
	`returns_amount` integer NOT NULL,
	`net_amount` integer NOT NULL,
	FOREIGN KEY (`shift_closure_id`) REFERENCES `shift_closures`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "chk_shift_closure_method_totals_hlc_len" CHECK(length("shift_closure_method_totals"."hlc") = 58),
	CONSTRAINT "chk_shift_closure_method_totals_created_at_ms_int" CHECK(typeof("shift_closure_method_totals"."created_at_ms") = 'integer'),
	CONSTRAINT "chk_shift_closure_method_totals_sales_amount_int" CHECK(typeof("shift_closure_method_totals"."sales_amount") = 'integer'),
	CONSTRAINT "chk_shift_closure_method_totals_returns_amount_int" CHECK(typeof("shift_closure_method_totals"."returns_amount") = 'integer'),
	CONSTRAINT "chk_shift_closure_method_totals_net_amount_int" CHECK(typeof("shift_closure_method_totals"."net_amount") = 'integer'),
	CONSTRAINT "chk_shift_closure_methods_enum" CHECK("shift_closure_method_totals"."method" IN ('cash', 'card', 'uzqr', 'payme', 'click', 'uzum', 'social_card', 'other', 'advance', 'debt')),
	CONSTRAINT "chk_shift_closure_methods_nonneg" CHECK("shift_closure_method_totals"."sales_amount" >= 0 AND "shift_closure_method_totals"."returns_amount" >= 0)
);--> statement-breakpoint
INSERT INTO `shift_closure_method_totals` SELECT * FROM `__tmp_shift_closure_method_totals`;--> statement-breakpoint
DROP TABLE `__tmp_shift_closure_method_totals`;--> statement-breakpoint
CREATE UNIQUE INDEX `uidx_shift_closure_methods` ON `shift_closure_method_totals` (`shift_closure_id`,`method`);--> statement-breakpoint
CREATE TABLE `shift_closure_cashiers` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`store_id` text NOT NULL,
	`device_id` text NOT NULL,
	`hlc` text NOT NULL,
	`created_at_ms` integer NOT NULL,
	`shift_closure_id` text NOT NULL,
	`session_id` text NOT NULL,
	`cashier_user_id` text NOT NULL,
	`session_seq` integer NOT NULL,
	`opening_float` integer NOT NULL,
	`expected_cash` integer NOT NULL,
	`counted_cash` integer NOT NULL,
	`discrepancy` integer NOT NULL,
	`sales_count` integer NOT NULL,
	`returns_count` integer NOT NULL,
	`sales_total` integer NOT NULL,
	`returns_total` integer NOT NULL,
	`cash_in_total` integer NOT NULL,
	`cash_out_total` integer NOT NULL,
	FOREIGN KEY (`shift_closure_id`) REFERENCES `shift_closures`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`session_id`) REFERENCES `shift_cashier_sessions`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`cashier_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "chk_shift_closure_cashiers_hlc_len" CHECK(length("shift_closure_cashiers"."hlc") = 58),
	CONSTRAINT "chk_shift_closure_cashiers_created_at_ms_int" CHECK(typeof("shift_closure_cashiers"."created_at_ms") = 'integer'),
	CONSTRAINT "chk_shift_closure_cashiers_opening_float_int" CHECK(typeof("shift_closure_cashiers"."opening_float") = 'integer'),
	CONSTRAINT "chk_shift_closure_cashiers_expected_cash_int" CHECK(typeof("shift_closure_cashiers"."expected_cash") = 'integer'),
	CONSTRAINT "chk_shift_closure_cashiers_counted_cash_int" CHECK(typeof("shift_closure_cashiers"."counted_cash") = 'integer'),
	CONSTRAINT "chk_shift_closure_cashiers_discrepancy_int" CHECK(typeof("shift_closure_cashiers"."discrepancy") = 'integer'),
	CONSTRAINT "chk_shift_closure_cashiers_sales_total_int" CHECK(typeof("shift_closure_cashiers"."sales_total") = 'integer'),
	CONSTRAINT "chk_shift_closure_cashiers_returns_total_int" CHECK(typeof("shift_closure_cashiers"."returns_total") = 'integer'),
	CONSTRAINT "chk_shift_closure_cashiers_cash_in_total_int" CHECK(typeof("shift_closure_cashiers"."cash_in_total") = 'integer'),
	CONSTRAINT "chk_shift_closure_cashiers_cash_out_total_int" CHECK(typeof("shift_closure_cashiers"."cash_out_total") = 'integer'),
	CONSTRAINT "chk_shift_closure_cashiers_nonneg" CHECK("shift_closure_cashiers"."session_seq" >= 1 AND "shift_closure_cashiers"."opening_float" >= 0 AND "shift_closure_cashiers"."counted_cash" >= 0 AND "shift_closure_cashiers"."sales_count" >= 0 AND "shift_closure_cashiers"."returns_count" >= 0 AND "shift_closure_cashiers"."sales_total" >= 0 AND "shift_closure_cashiers"."returns_total" >= 0 AND "shift_closure_cashiers"."cash_in_total" >= 0 AND "shift_closure_cashiers"."cash_out_total" >= 0)
);--> statement-breakpoint
INSERT INTO `shift_closure_cashiers` SELECT * FROM `__tmp_shift_closure_cashiers`;--> statement-breakpoint
DROP TABLE `__tmp_shift_closure_cashiers`;--> statement-breakpoint
CREATE UNIQUE INDEX `uidx_shift_closure_cashiers_sess` ON `shift_closure_cashiers` (`shift_closure_id`,`session_id`);--> statement-breakpoint
CREATE TABLE `__new_local_device_state` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`created_at_ms` integer NOT NULL,
	`updated_at_ms` integer NOT NULL,
	`device_id` text NOT NULL,
	`last_device_seq` integer NOT NULL,
	`last_receipt_seq` integer DEFAULT 0 NOT NULL,
	`last_return_seq` integer DEFAULT 0 NOT NULL,
	`last_receiving_seq` integer DEFAULT 0 NOT NULL,
	`last_supplier_return_seq` integer DEFAULT 0 NOT NULL,
	`last_shift_seq` integer DEFAULT 0 NOT NULL,
	`last_order_seq` integer DEFAULT 0 NOT NULL,
	`last_hlc` text NOT NULL,
	`last_uuid_ms` integer NOT NULL,
	CONSTRAINT "chk_local_device_state_created_at_ms_int" CHECK(typeof("__new_local_device_state"."created_at_ms") = 'integer'),
	CONSTRAINT "chk_local_device_state_updated_at_ms_int" CHECK(typeof("__new_local_device_state"."updated_at_ms") = 'integer'),
	CONSTRAINT "chk_local_device_state_last_device_seq_int" CHECK(typeof("__new_local_device_state"."last_device_seq") = 'integer'),
	CONSTRAINT "chk_local_device_state_last_receipt_seq_int" CHECK(typeof("__new_local_device_state"."last_receipt_seq") = 'integer'),
	CONSTRAINT "chk_local_device_state_last_return_seq_int" CHECK(typeof("__new_local_device_state"."last_return_seq") = 'integer'),
	CONSTRAINT "chk_local_device_state_last_receiving_seq_int" CHECK(typeof("__new_local_device_state"."last_receiving_seq") = 'integer'),
	CONSTRAINT "chk_local_device_state_last_supplier_return_seq_int" CHECK(typeof("__new_local_device_state"."last_supplier_return_seq") = 'integer'),
	CONSTRAINT "chk_local_device_state_last_shift_seq_int" CHECK(typeof("__new_local_device_state"."last_shift_seq") = 'integer'),
	CONSTRAINT "chk_local_device_state_last_order_seq_int" CHECK(typeof("__new_local_device_state"."last_order_seq") = 'integer'),
	CONSTRAINT "chk_local_device_state_last_hlc_len" CHECK(length("__new_local_device_state"."last_hlc") = 58),
	CONSTRAINT "chk_local_device_state_last_uuid_ms_int" CHECK(typeof("__new_local_device_state"."last_uuid_ms") = 'integer'),
	CONSTRAINT "chk_local_device_state_seq_nonneg" CHECK("__new_local_device_state"."last_device_seq" >= 0),
	CONSTRAINT "chk_local_device_state_receipt_nonneg" CHECK("__new_local_device_state"."last_receipt_seq" >= 0),
	CONSTRAINT "chk_local_device_state_return_nonneg" CHECK("__new_local_device_state"."last_return_seq" >= 0),
	CONSTRAINT "chk_local_device_state_receiving_nonneg" CHECK("__new_local_device_state"."last_receiving_seq" >= 0),
	CONSTRAINT "chk_local_device_state_sup_return_nonneg" CHECK("__new_local_device_state"."last_supplier_return_seq" >= 0),
	CONSTRAINT "chk_local_device_state_shift_nonneg" CHECK("__new_local_device_state"."last_shift_seq" >= 0),
	CONSTRAINT "chk_local_device_state_order_nonneg" CHECK("__new_local_device_state"."last_order_seq" >= 0)
);--> statement-breakpoint
INSERT INTO `__new_local_device_state`("id", "organization_id", "created_at_ms", "updated_at_ms", "device_id", "last_device_seq", "last_receipt_seq", "last_return_seq", "last_receiving_seq", "last_supplier_return_seq", "last_shift_seq", "last_order_seq", "last_hlc", "last_uuid_ms") SELECT "id", "organization_id", "created_at_ms", "updated_at_ms", "device_id", "last_device_seq", "last_receipt_seq", "last_return_seq", "last_receiving_seq", "last_supplier_return_seq", "last_shift_seq", 0, "last_hlc", "last_uuid_ms" FROM `local_device_state`;--> statement-breakpoint
DROP TABLE `local_device_state`;--> statement-breakpoint
ALTER TABLE `__new_local_device_state` RENAME TO `local_device_state`;--> statement-breakpoint
CREATE UNIQUE INDEX `uidx_local_device_state_device_id` ON `local_device_state` (`device_id`);--> statement-breakpoint
ALTER TABLE `sales` ADD `source_order_id` text;--> statement-breakpoint
CREATE INDEX `idx_sales_store_order` ON `sales` (`organization_id`,`store_id`,`source_order_id`);--> statement-breakpoint
DROP TRIGGER IF EXISTS "trg_orders_no_delete";--> statement-breakpoint
CREATE TRIGGER "trg_orders_no_delete"
BEFORE DELETE ON "orders"
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'MONOTONE table "orders" forbids physical DELETE: use tombstone');
END;--> statement-breakpoint
DROP TRIGGER IF EXISTS "trg_orders_terminal_monotone";--> statement-breakpoint
CREATE TRIGGER "trg_orders_terminal_monotone"
BEFORE UPDATE ON "orders"
FOR EACH ROW
WHEN OLD."status" IN ('delivered', 'cancelled')
BEGIN
  SELECT RAISE(ABORT, 'MONOTONE table "orders" cannot be modified once delivered or cancelled');
END;--> statement-breakpoint
DROP TRIGGER IF EXISTS "trg_orders_immutable_core";--> statement-breakpoint
CREATE TRIGGER "trg_orders_immutable_core"
BEFORE UPDATE ON "orders"
FOR EACH ROW
WHEN
  (OLD."status" = 'draft' AND NEW."status" NOT IN ('confirmed', 'cancelled')) OR
  (OLD."status" = 'confirmed' AND NEW."status" NOT IN ('ready', 'delivered', 'cancelled')) OR
  (OLD."status" = 'ready' AND NEW."status" NOT IN ('delivered', 'cancelled')) OR
  (NEW."status" = 'confirmed' AND NEW."confirmed_at_ms" IS NULL) OR
  (NEW."status" = 'ready' AND NEW."ready_at_ms" IS NULL) OR
  (NEW."status" = 'delivered' AND (NEW."delivered_at_ms" IS NULL OR NEW."delivered_sale_id" IS NULL)) OR
  (NEW."status" = 'cancelled' AND (NEW."cancelled_at_ms" IS NULL OR NEW."cancelled_by_user_id" IS NULL OR NEW."cancel_reason" IS NULL OR length(trim(NEW."cancel_reason")) = 0)) OR
  NEW."id" IS NOT OLD."id" OR
  NEW."organization_id" IS NOT OLD."organization_id" OR
  NEW."store_id" IS NOT OLD."store_id" OR
  NEW."origin_device_id" IS NOT OLD."origin_device_id" OR
  NEW."order_no" IS NOT OLD."order_no" OR
  NEW."order_code" IS NOT OLD."order_code" OR
  NEW."customer_id" IS NOT OLD."customer_id" OR
  NEW."customer_name" IS NOT OLD."customer_name" OR
  NEW."customer_phone_normalized" IS NOT OLD."customer_phone_normalized" OR
  NEW."due_at_ms" IS NOT OLD."due_at_ms" OR
  NEW."note" IS NOT OLD."note" OR
  NEW."subtotal_gross" IS NOT OLD."subtotal_gross" OR
  NEW."total_promo_discount" IS NOT OLD."total_promo_discount" OR
  NEW."subtotal_after_promo" IS NOT OLD."subtotal_after_promo" OR
  NEW."manual_discount_mode" IS NOT OLD."manual_discount_mode" OR
  NEW."manual_discount_value" IS NOT OLD."manual_discount_value" OR
  NEW."manual_discount_reason" IS NOT OLD."manual_discount_reason" OR
  NEW."order_discount_amount" IS NOT OLD."order_discount_amount" OR
  NEW."total_amount" IS NOT OLD."total_amount" OR
  NEW."total_net_ex_vat" IS NOT OLD."total_net_ex_vat" OR
  NEW."total_vat" IS NOT OLD."total_vat" OR
  NEW."override_approved_by_user_id" IS NOT OLD."override_approved_by_user_id" OR
  NEW."override_approved_amount" IS NOT OLD."override_approved_amount" OR
  NEW."created_by_user_id" IS NOT OLD."created_by_user_id" OR
  NEW."created_at_ms" IS NOT OLD."created_at_ms" OR
  NEW."create_client_request_id" IS NOT OLD."create_client_request_id" OR
  NEW."create_request_hash" IS NOT OLD."create_request_hash" OR
  (OLD."confirmed_at_ms" IS NOT NULL AND NEW."confirmed_at_ms" IS NOT OLD."confirmed_at_ms") OR
  (OLD."ready_at_ms" IS NOT NULL AND NEW."ready_at_ms" IS NOT OLD."ready_at_ms")
BEGIN
  SELECT RAISE(ABORT, 'MONOTONE table "orders" forbids invalid transitions or mutating frozen totals');
END;--> statement-breakpoint
DROP TRIGGER IF EXISTS "trg_order_lines_no_update";--> statement-breakpoint
CREATE TRIGGER "trg_order_lines_no_update"
BEFORE UPDATE ON "order_lines"
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'FACT table "order_lines" is immutable: UPDATE is forbidden');
END;--> statement-breakpoint
DROP TRIGGER IF EXISTS "trg_order_lines_no_delete";--> statement-breakpoint
CREATE TRIGGER "trg_order_lines_no_delete"
BEFORE DELETE ON "order_lines"
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'FACT table "order_lines" forbids physical DELETE: use tombstone');
END;--> statement-breakpoint
DROP TRIGGER IF EXISTS "trg_order_payments_no_update";--> statement-breakpoint
CREATE TRIGGER "trg_order_payments_no_update"
BEFORE UPDATE ON "order_payments"
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'FACT table "order_payments" is immutable: UPDATE is forbidden');
END;--> statement-breakpoint
DROP TRIGGER IF EXISTS "trg_order_payments_no_delete";--> statement-breakpoint
CREATE TRIGGER "trg_order_payments_no_delete"
BEFORE DELETE ON "order_payments"
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'FACT table "order_payments" forbids physical DELETE: use tombstone');
END;--> statement-breakpoint
DROP TRIGGER IF EXISTS "trg_order_payments_closed_shift_guard";--> statement-breakpoint
-- X5 (F2 sync note): Blocks local POS/hub inserts into an already-closed shift.
-- When F2 adds remote peer/cloud sync writes, update this trigger WHEN clause to permit
-- explicit F2 sync-mode inserts so historical advance records for closed shifts can sync safely.
CREATE TRIGGER "trg_order_payments_closed_shift_guard"
BEFORE INSERT ON "order_payments"
FOR EACH ROW
WHEN NEW."shift_id" IS NOT NULL AND EXISTS (
  SELECT 1 FROM "shifts" sh WHERE sh."id" = NEW."shift_id" AND sh."status" = 'closed'
)
BEGIN
  SELECT RAISE(ABORT, 'Cannot insert into "order_payments" referencing an already closed shift');
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
  NEW."source_order_id" IS NOT OLD."source_order_id" OR
  NEW."cashier_user_id" IS NOT OLD."cashier_user_id" OR
  NEW."completed_by_user_id" IS NOT OLD."completed_by_user_id" OR
  NEW."customer_id" IS NOT OLD."customer_id" OR
  NEW."shift_id" IS NOT OLD."shift_id" OR
  NEW."shift_cashier_session_id" IS NOT OLD."shift_cashier_session_id" OR
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
DROP TRIGGER IF EXISTS "trg_cash_moves_closed_shift_guard";--> statement-breakpoint
-- X5 (F2 sync note): Blocks local POS/hub inserts into an already-closed shift.
-- When F2 adds remote peer/cloud sync writes, update this trigger WHEN clause to permit
-- explicit F2 sync-mode inserts so historical receipts for closed shifts can sync safely.
CREATE TRIGGER "trg_cash_moves_closed_shift_guard"
BEFORE INSERT ON "cash_moves"
FOR EACH ROW
WHEN NEW."shift_id" IS NOT NULL AND EXISTS (
  SELECT 1 FROM "shifts" sh WHERE sh."id" = NEW."shift_id" AND sh."status" = 'closed'
)
BEGIN
  SELECT RAISE(ABORT, 'Cannot insert into "cash_moves" referencing an already closed shift');
END;--> statement-breakpoint
DROP TRIGGER IF EXISTS "trg_cash_moves_expense_cat_guard";--> statement-breakpoint
CREATE TRIGGER "trg_cash_moves_expense_cat_guard"
BEFORE INSERT ON "cash_moves"
FOR EACH ROW
WHEN
  (NEW."type" <> 'cash_out' AND NEW."expense_category" IS NOT NULL) OR
  (NEW."expense_category" IS NOT NULL AND NEW."expense_category" NOT IN ('supplies', 'utilities', 'transport', 'repair', 'salary_advance', 'other'))
BEGIN
  SELECT RAISE(ABORT, 'Invalid expense_category on "cash_moves"');
END;--> statement-breakpoint
DROP TRIGGER IF EXISTS "trg_customer_ledger_no_update";--> statement-breakpoint
CREATE TRIGGER "trg_customer_ledger_no_update"
BEFORE UPDATE ON "customer_ledger"
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'FACT table "customer_ledger" is immutable: UPDATE is forbidden');
END;--> statement-breakpoint
DROP TRIGGER IF EXISTS "trg_customer_ledger_no_delete";--> statement-breakpoint
CREATE TRIGGER "trg_customer_ledger_no_delete"
BEFORE DELETE ON "customer_ledger"
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'FACT table "customer_ledger" forbids physical DELETE: use tombstone');
END;--> statement-breakpoint
DROP TRIGGER IF EXISTS "trg_supplier_ledger_no_update";--> statement-breakpoint
CREATE TRIGGER "trg_supplier_ledger_no_update"
BEFORE UPDATE ON "supplier_ledger"
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'FACT table "supplier_ledger" is immutable: UPDATE is forbidden');
END;--> statement-breakpoint
DROP TRIGGER IF EXISTS "trg_supplier_ledger_no_delete";--> statement-breakpoint
CREATE TRIGGER "trg_supplier_ledger_no_delete"
BEFORE DELETE ON "supplier_ledger"
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'FACT table "supplier_ledger" forbids physical DELETE: use tombstone');
END;--> statement-breakpoint
DROP TRIGGER IF EXISTS "trg_shift_closures_no_update";--> statement-breakpoint
CREATE TRIGGER "trg_shift_closures_no_update"
BEFORE UPDATE ON "shift_closures"
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'FACT table "shift_closures" is immutable: UPDATE is forbidden');
END;--> statement-breakpoint
DROP TRIGGER IF EXISTS "trg_shift_closures_no_delete";--> statement-breakpoint
CREATE TRIGGER "trg_shift_closures_no_delete"
BEFORE DELETE ON "shift_closures"
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'FACT table "shift_closures" forbids physical DELETE: use tombstone');
END;--> statement-breakpoint
DROP TRIGGER IF EXISTS "trg_shift_closure_method_totals_no_update";--> statement-breakpoint
CREATE TRIGGER "trg_shift_closure_method_totals_no_update"
BEFORE UPDATE ON "shift_closure_method_totals"
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'FACT table "shift_closure_method_totals" is immutable: UPDATE is forbidden');
END;--> statement-breakpoint
DROP TRIGGER IF EXISTS "trg_shift_closure_method_totals_no_delete";--> statement-breakpoint
CREATE TRIGGER "trg_shift_closure_method_totals_no_delete"
BEFORE DELETE ON "shift_closure_method_totals"
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'FACT table "shift_closure_method_totals" forbids physical DELETE: use tombstone');
END;--> statement-breakpoint
DROP TRIGGER IF EXISTS "trg_shift_closure_cashiers_no_update";--> statement-breakpoint
CREATE TRIGGER "trg_shift_closure_cashiers_no_update"
BEFORE UPDATE ON "shift_closure_cashiers"
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'FACT table "shift_closure_cashiers" is immutable: UPDATE is forbidden');
END;--> statement-breakpoint
DROP TRIGGER IF EXISTS "trg_shift_closure_cashiers_no_delete";--> statement-breakpoint
CREATE TRIGGER "trg_shift_closure_cashiers_no_delete"
BEFORE DELETE ON "shift_closure_cashiers"
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'FACT table "shift_closure_cashiers" forbids physical DELETE: use tombstone');
END;
