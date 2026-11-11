CREATE TABLE `__tmp_customer_ledger` AS SELECT * FROM `customer_ledger`;--> statement-breakpoint
DROP TABLE `customer_ledger`;--> statement-breakpoint
CREATE TABLE `__new_cash_moves` (
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
	CONSTRAINT "chk_cash_moves_hlc_len" CHECK(length("__new_cash_moves"."hlc") = 58),
	CONSTRAINT "chk_cash_moves_created_at_ms_int" CHECK(typeof("__new_cash_moves"."created_at_ms") = 'integer'),
	CONSTRAINT "chk_cash_moves_amount_delta_int" CHECK(typeof("__new_cash_moves"."amount_delta") = 'integer'),
	CONSTRAINT "chk_cash_moves_type" CHECK("__new_cash_moves"."type" IN ('sale_cash_in', 'debt_payment_in', 'cash_in', 'sale_change_out', 'refund_cash_out', 'supplier_payment_out', 'cash_out', 'encashment')),
	CONSTRAINT "chk_cash_moves_amount_sign" CHECK(("__new_cash_moves"."type" IN ('sale_cash_in', 'debt_payment_in', 'cash_in') AND "__new_cash_moves"."amount_delta" > 0) OR ("__new_cash_moves"."type" IN ('sale_change_out', 'refund_cash_out', 'supplier_payment_out', 'cash_out', 'encashment') AND "__new_cash_moves"."amount_delta" < 0)),
	CONSTRAINT "chk_cash_moves_source_type" CHECK(length(trim("__new_cash_moves"."source_type")) >= 1)
);--> statement-breakpoint
INSERT INTO `__new_cash_moves`("id", "organization_id", "store_id", "device_id", "hlc", "created_at_ms", "shift_id", "type", "amount_delta", "source_type", "source_id", "payment_id", "reason", "created_by_user_id") SELECT "id", "organization_id", "store_id", "device_id", "hlc", "created_at_ms", "shift_id", "type", "amount_delta", "source_type", "source_id", "payment_id", "reason", "created_by_user_id" FROM `cash_moves`;--> statement-breakpoint
DROP TABLE `cash_moves`;--> statement-breakpoint
ALTER TABLE `__new_cash_moves` RENAME TO `cash_moves`;--> statement-breakpoint
CREATE INDEX `idx_cash_moves_store_created` ON `cash_moves` (`organization_id`,`store_id`,`created_at_ms`);--> statement-breakpoint
CREATE INDEX `idx_cash_moves_terminal` ON `cash_moves` (`organization_id`,`store_id`,`device_id`,`created_at_ms`);--> statement-breakpoint
CREATE INDEX `idx_cash_moves_shift_created` ON `cash_moves` (`organization_id`,`store_id`,`shift_id`,`created_at_ms`);--> statement-breakpoint
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
CREATE TABLE `__new_stock_moves` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`store_id` text NOT NULL,
	`device_id` text NOT NULL,
	`hlc` text NOT NULL,
	`created_at_ms` integer NOT NULL,
	`product_id` text NOT NULL,
	`variant_id` text,
	`batch_id` text,
	`qty_delta` integer NOT NULL,
	`cost_value_delta` integer NOT NULL,
	`reason` text NOT NULL,
	`source_type` text NOT NULL,
	`source_id` text NOT NULL,
	`created_by_user_id` text NOT NULL,
	`note` text,
	FOREIGN KEY (`product_id`) REFERENCES `products`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`variant_id`) REFERENCES `product_variants`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`batch_id`) REFERENCES `batches`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "chk_stock_moves_hlc_len" CHECK(length("__new_stock_moves"."hlc") = 58),
	CONSTRAINT "chk_stock_moves_created_at_ms_int" CHECK(typeof("__new_stock_moves"."created_at_ms") = 'integer'),
	CONSTRAINT "chk_stock_moves_qty_delta_int" CHECK(typeof("__new_stock_moves"."qty_delta") = 'integer'),
	CONSTRAINT "chk_stock_moves_cost_value_delta_int" CHECK(typeof("__new_stock_moves"."cost_value_delta") = 'integer'),
	CONSTRAINT "chk_stock_moves_qty_nonzero" CHECK("__new_stock_moves"."qty_delta" <> 0),
	CONSTRAINT "chk_stock_moves_sign_match" CHECK(("__new_stock_moves"."qty_delta" > 0 AND "__new_stock_moves"."cost_value_delta" >= 0) OR ("__new_stock_moves"."qty_delta" < 0 AND "__new_stock_moves"."cost_value_delta" <= 0)),
	CONSTRAINT "chk_stock_moves_reason" CHECK("__new_stock_moves"."reason" IN ('initial', 'purchase', 'sale', 'return', 'supplier_return', 'inventory', 'adjustment', 'damaged', 'broken', 'personal', 'lost')),
	CONSTRAINT "chk_stock_moves_source_type" CHECK("__new_stock_moves"."source_type" IN ('stock_entry', 'inventory_count', 'sale', 'return', 'purchase', 'supplier_return', 'adjustment'))
);--> statement-breakpoint
INSERT INTO `__new_stock_moves`("id", "organization_id", "store_id", "device_id", "hlc", "created_at_ms", "product_id", "variant_id", "batch_id", "qty_delta", "cost_value_delta", "reason", "source_type", "source_id", "created_by_user_id", "note") SELECT "id", "organization_id", "store_id", "device_id", "hlc", "created_at_ms", "product_id", "variant_id", "batch_id", "qty_delta", "cost_value_delta", "reason", "source_type", "source_id", "created_by_user_id", "note" FROM `stock_moves`;--> statement-breakpoint
DROP TABLE `stock_moves`;--> statement-breakpoint
ALTER TABLE `__new_stock_moves` RENAME TO `stock_moves`;--> statement-breakpoint
CREATE INDEX `idx_stock_moves_store_prod_hlc` ON `stock_moves` (`organization_id`,`store_id`,`product_id`,`variant_id`,`hlc`,`id`);--> statement-breakpoint
CREATE INDEX `idx_stock_moves_store_batch` ON `stock_moves` (`organization_id`,`store_id`,`batch_id`,`hlc`,`id`);--> statement-breakpoint
CREATE INDEX `idx_stock_moves_store_source` ON `stock_moves` (`organization_id`,`store_id`,`source_type`,`source_id`);--> statement-breakpoint
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
	`last_hlc` text NOT NULL,
	`last_uuid_ms` integer NOT NULL,
	CONSTRAINT "chk_local_device_state_created_at_ms_int" CHECK(typeof("__new_local_device_state"."created_at_ms") = 'integer'),
	CONSTRAINT "chk_local_device_state_updated_at_ms_int" CHECK(typeof("__new_local_device_state"."updated_at_ms") = 'integer'),
	CONSTRAINT "chk_local_device_state_last_device_seq_int" CHECK(typeof("__new_local_device_state"."last_device_seq") = 'integer'),
	CONSTRAINT "chk_local_device_state_last_receipt_seq_int" CHECK(typeof("__new_local_device_state"."last_receipt_seq") = 'integer'),
	CONSTRAINT "chk_local_device_state_last_return_seq_int" CHECK(typeof("__new_local_device_state"."last_return_seq") = 'integer'),
	CONSTRAINT "chk_local_device_state_last_receiving_seq_int" CHECK(typeof("__new_local_device_state"."last_receiving_seq") = 'integer'),
	CONSTRAINT "chk_local_device_state_last_supplier_return_seq_int" CHECK(typeof("__new_local_device_state"."last_supplier_return_seq") = 'integer'),
	CONSTRAINT "chk_local_device_state_last_hlc_len" CHECK(length("__new_local_device_state"."last_hlc") = 58),
	CONSTRAINT "chk_local_device_state_last_uuid_ms_int" CHECK(typeof("__new_local_device_state"."last_uuid_ms") = 'integer'),
	CONSTRAINT "chk_local_device_state_seq_nonneg" CHECK("__new_local_device_state"."last_device_seq" >= 0),
	CONSTRAINT "chk_local_device_state_receipt_nonneg" CHECK("__new_local_device_state"."last_receipt_seq" >= 0),
	CONSTRAINT "chk_local_device_state_return_nonneg" CHECK("__new_local_device_state"."last_return_seq" >= 0),
	CONSTRAINT "chk_local_device_state_receiving_nonneg" CHECK("__new_local_device_state"."last_receiving_seq" >= 0),
	CONSTRAINT "chk_local_device_state_sup_return_nonneg" CHECK("__new_local_device_state"."last_supplier_return_seq" >= 0)
);--> statement-breakpoint
INSERT INTO `__new_local_device_state`("id", "organization_id", "created_at_ms", "updated_at_ms", "device_id", "last_device_seq", "last_receipt_seq", "last_return_seq", "last_receiving_seq", "last_supplier_return_seq", "last_hlc", "last_uuid_ms") SELECT "id", "organization_id", "created_at_ms", "updated_at_ms", "device_id", "last_device_seq", "last_receipt_seq", "last_return_seq", 0, 0, "last_hlc", "last_uuid_ms" FROM `local_device_state`;--> statement-breakpoint
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
	`default_customer_due_days` integer DEFAULT 14,
	`default_supplier_due_days` integer DEFAULT 14,
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
	CONSTRAINT "chk_local_hub_config_timezone_nonempty" CHECK(length(trim("__new_local_hub_config"."store_timezone")) >= 1),
	CONSTRAINT "chk_local_hub_config_cust_due_days" CHECK("__new_local_hub_config"."default_customer_due_days" IS NULL OR ("__new_local_hub_config"."default_customer_due_days" >= 1 AND "__new_local_hub_config"."default_customer_due_days" <= 3650)),
	CONSTRAINT "chk_local_hub_config_sup_due_days" CHECK("__new_local_hub_config"."default_supplier_due_days" IS NULL OR ("__new_local_hub_config"."default_supplier_due_days" >= 1 AND "__new_local_hub_config"."default_supplier_due_days" <= 3650))
);--> statement-breakpoint
INSERT INTO `__new_local_hub_config`("id", "organization_id", "created_at_ms", "updated_at_ms", "store_id", "device_id", "singleton_guard", "setup_completed_at_ms", "negative_stock_policy", "cashier_discount_percent_unlimited", "cashier_max_discount_percent_bp", "cashier_discount_amount_unlimited", "cashier_max_discount_amount", "quick_sale_default_mxik", "quick_sale_default_vat_rate_bp", "store_timezone", "default_customer_due_days", "default_supplier_due_days") SELECT "id", "organization_id", "created_at_ms", "updated_at_ms", "store_id", "device_id", "singleton_guard", "setup_completed_at_ms", "negative_stock_policy", "cashier_discount_percent_unlimited", "cashier_max_discount_percent_bp", "cashier_discount_amount_unlimited", "cashier_max_discount_amount", "quick_sale_default_mxik", "quick_sale_default_vat_rate_bp", "store_timezone", "default_customer_due_days", 14 FROM `local_hub_config`;--> statement-breakpoint
DROP TABLE `local_hub_config`;--> statement-breakpoint
ALTER TABLE `__new_local_hub_config` RENAME TO `local_hub_config`;--> statement-breakpoint
CREATE UNIQUE INDEX `uidx_local_hub_config_singleton` ON `local_hub_config` (`singleton_guard`);--> statement-breakpoint
CREATE TABLE `suppliers` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`device_id` text NOT NULL,
	`hlc` text NOT NULL,
	`created_at_ms` integer NOT NULL,
	`updated_at_ms` integer NOT NULL,
	`deleted_at_ms` integer,
	`name` text NOT NULL,
	`name_search` text NOT NULL,
	`tin` text,
	`phone_normalized` text,
	`phone_digits` text,
	`contact_person` text,
	`note` text,
	`default_due_days` integer,
	`is_active` integer DEFAULT true NOT NULL,
	CONSTRAINT "chk_suppliers_hlc_len" CHECK(length("suppliers"."hlc") = 58),
	CONSTRAINT "chk_suppliers_created_at_ms_int" CHECK(typeof("suppliers"."created_at_ms") = 'integer'),
	CONSTRAINT "chk_suppliers_updated_at_ms_int" CHECK(typeof("suppliers"."updated_at_ms") = 'integer'),
	CONSTRAINT "chk_suppliers_deleted_at_ms_int" CHECK("suppliers"."deleted_at_ms" IS NULL OR typeof("suppliers"."deleted_at_ms") = 'integer'),
	CONSTRAINT "chk_suppliers_name_nonempty" CHECK(length(trim("suppliers"."name")) >= 1),
	CONSTRAINT "chk_suppliers_tin_len" CHECK("suppliers"."tin" IS NULL OR length("suppliers"."tin") = 9),
	CONSTRAINT "chk_suppliers_active" CHECK("suppliers"."is_active" IN (0, 1)),
	CONSTRAINT "chk_suppliers_due_days" CHECK("suppliers"."default_due_days" IS NULL OR ("suppliers"."default_due_days" >= 1 AND "suppliers"."default_due_days" <= 3650))
);--> statement-breakpoint
CREATE UNIQUE INDEX `uidx_suppliers_org_tin_active` ON `suppliers` (`organization_id`,`tin`) WHERE "suppliers"."tin" IS NOT NULL AND "suppliers"."deleted_at_ms" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `uidx_suppliers_org_phone_active` ON `suppliers` (`organization_id`,`phone_normalized`) WHERE "suppliers"."phone_normalized" IS NOT NULL AND "suppliers"."deleted_at_ms" IS NULL;--> statement-breakpoint
CREATE INDEX `idx_suppliers_org_active_name` ON `suppliers` (`organization_id`,`is_active`,`name_search`) WHERE "suppliers"."deleted_at_ms" IS NULL;--> statement-breakpoint
CREATE TABLE `local_receiving_drafts` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`store_id` text NOT NULL,
	`created_at_ms` integer NOT NULL,
	`updated_at_ms` integer NOT NULL,
	`supplier_id` text NOT NULL,
	`supplier_invoice_no` text,
	`due_days` integer,
	`note` text,
	`status` text DEFAULT 'draft' NOT NULL,
	`created_by_user_id` text NOT NULL,
	`posted_at_ms` integer,
	`cancelled_at_ms` integer,
	FOREIGN KEY (`supplier_id`) REFERENCES `suppliers`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "chk_local_receiving_drafts_created_at_ms_int" CHECK(typeof("local_receiving_drafts"."created_at_ms") = 'integer'),
	CONSTRAINT "chk_local_receiving_drafts_updated_at_ms_int" CHECK(typeof("local_receiving_drafts"."updated_at_ms") = 'integer'),
	CONSTRAINT "chk_local_receiving_drafts_posted_at_ms_int" CHECK("local_receiving_drafts"."posted_at_ms" IS NULL OR typeof("local_receiving_drafts"."posted_at_ms") = 'integer'),
	CONSTRAINT "chk_local_receiving_drafts_cancelled_at_ms_int" CHECK("local_receiving_drafts"."cancelled_at_ms" IS NULL OR typeof("local_receiving_drafts"."cancelled_at_ms") = 'integer'),
	CONSTRAINT "chk_local_rcv_drafts_status" CHECK("local_receiving_drafts"."status" IN ('draft', 'posted', 'cancelled')),
	CONSTRAINT "chk_local_rcv_drafts_due_days" CHECK("local_receiving_drafts"."due_days" IS NULL OR ("local_receiving_drafts"."due_days" >= 1 AND "local_receiving_drafts"."due_days" <= 3650))
);--> statement-breakpoint
CREATE INDEX `idx_local_rcv_drafts_store_status` ON `local_receiving_drafts` (`organization_id`,`store_id`,`status`,`created_at_ms`);--> statement-breakpoint
CREATE TABLE `local_receiving_draft_lines` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`store_id` text NOT NULL,
	`created_at_ms` integer NOT NULL,
	`updated_at_ms` integer NOT NULL,
	`draft_id` text NOT NULL,
	`sort_order` integer NOT NULL,
	`product_id` text NOT NULL,
	`variant_id` text,
	`qty` integer NOT NULL,
	`cost_unknown` integer NOT NULL,
	`total_cost_value` integer,
	`vat_rate_bp` integer,
	`vat_amount` integer,
	`batch_number` text,
	`expiry_date_ms` integer,
	FOREIGN KEY (`draft_id`) REFERENCES `local_receiving_drafts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`product_id`) REFERENCES `products`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`variant_id`) REFERENCES `product_variants`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "chk_local_receiving_draft_lines_created_at_ms_int" CHECK(typeof("local_receiving_draft_lines"."created_at_ms") = 'integer'),
	CONSTRAINT "chk_local_receiving_draft_lines_updated_at_ms_int" CHECK(typeof("local_receiving_draft_lines"."updated_at_ms") = 'integer'),
	CONSTRAINT "chk_local_receiving_draft_lines_qty_int" CHECK(typeof("local_receiving_draft_lines"."qty") = 'integer'),
	CONSTRAINT "chk_local_receiving_draft_lines_total_cost_value_int" CHECK("local_receiving_draft_lines"."total_cost_value" IS NULL OR typeof("local_receiving_draft_lines"."total_cost_value") = 'integer'),
	CONSTRAINT "chk_local_receiving_draft_lines_vat_amount_int" CHECK("local_receiving_draft_lines"."vat_amount" IS NULL OR typeof("local_receiving_draft_lines"."vat_amount") = 'integer'),
	CONSTRAINT "chk_local_receiving_draft_lines_expiry_date_ms_int" CHECK("local_receiving_draft_lines"."expiry_date_ms" IS NULL OR typeof("local_receiving_draft_lines"."expiry_date_ms") = 'integer'),
	CONSTRAINT "chk_local_rcv_draft_lines_sort_nonneg" CHECK("local_receiving_draft_lines"."sort_order" >= 0),
	CONSTRAINT "chk_local_rcv_draft_lines_qty_pos" CHECK("local_receiving_draft_lines"."qty" > 0),
	CONSTRAINT "chk_local_rcv_draft_lines_unknown_bool" CHECK("local_receiving_draft_lines"."cost_unknown" IN (0, 1)),
	CONSTRAINT "chk_local_rcv_draft_lines_cost_pair" CHECK(("local_receiving_draft_lines"."cost_unknown" = 1 AND "local_receiving_draft_lines"."total_cost_value" IS NULL) OR ("local_receiving_draft_lines"."cost_unknown" = 0 AND "local_receiving_draft_lines"."total_cost_value" IS NOT NULL AND "local_receiving_draft_lines"."total_cost_value" >= 0)),
	CONSTRAINT "chk_local_rcv_draft_lines_vat_bp" CHECK("local_receiving_draft_lines"."vat_rate_bp" IS NULL OR ("local_receiving_draft_lines"."vat_rate_bp" >= 0 AND "local_receiving_draft_lines"."vat_rate_bp" <= 10000)),
	CONSTRAINT "chk_local_rcv_draft_lines_vat_amt" CHECK("local_receiving_draft_lines"."vat_amount" IS NULL OR "local_receiving_draft_lines"."vat_amount" >= 0)
);--> statement-breakpoint
CREATE UNIQUE INDEX `uidx_local_rcv_draft_lines_sort` ON `local_receiving_draft_lines` (`draft_id`,`sort_order`);--> statement-breakpoint
CREATE INDEX `idx_local_rcv_draft_lines_draft` ON `local_receiving_draft_lines` (`draft_id`);--> statement-breakpoint
CREATE TABLE `goods_receivings` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`store_id` text NOT NULL,
	`device_id` text NOT NULL,
	`hlc` text NOT NULL,
	`created_at_ms` integer NOT NULL,
	`receiving_no` integer NOT NULL,
	`receiving_code` text NOT NULL,
	`supplier_id` text NOT NULL,
	`supplier_invoice_no` text,
	`due_days` integer,
	`due_at_ms` integer,
	`known_cost_total` integer NOT NULL,
	`unknown_cost_line_count` integer NOT NULL,
	`note` text,
	`posted_by_user_id` text NOT NULL,
	`client_request_id` text NOT NULL,
	`request_hash` text NOT NULL,
	FOREIGN KEY (`supplier_id`) REFERENCES `suppliers`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`posted_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "chk_goods_receivings_hlc_len" CHECK(length("goods_receivings"."hlc") = 58),
	CONSTRAINT "chk_goods_receivings_created_at_ms_int" CHECK(typeof("goods_receivings"."created_at_ms") = 'integer'),
	CONSTRAINT "chk_goods_receivings_receiving_no_int" CHECK(typeof("goods_receivings"."receiving_no") = 'integer'),
	CONSTRAINT "chk_goods_receivings_due_at_ms_int" CHECK("goods_receivings"."due_at_ms" IS NULL OR typeof("goods_receivings"."due_at_ms") = 'integer'),
	CONSTRAINT "chk_goods_receivings_known_cost_total_int" CHECK(typeof("goods_receivings"."known_cost_total") = 'integer'),
	CONSTRAINT "chk_goods_receivings_no_pos" CHECK("goods_receivings"."receiving_no" >= 1),
	CONSTRAINT "chk_goods_receivings_code_nonempty" CHECK(length(trim("goods_receivings"."receiving_code")) >= 1),
	CONSTRAINT "chk_goods_receivings_known_nonneg" CHECK("goods_receivings"."known_cost_total" >= 0),
	CONSTRAINT "chk_goods_receivings_unk_cnt_nonneg" CHECK("goods_receivings"."unknown_cost_line_count" >= 0),
	CONSTRAINT "chk_goods_receivings_req_hash_nonempty" CHECK(length(trim("goods_receivings"."request_hash")) >= 6)
);--> statement-breakpoint
CREATE UNIQUE INDEX `uidx_goods_receivings_org_dev_no` ON `goods_receivings` (`organization_id`,`device_id`,`receiving_no`);--> statement-breakpoint
CREATE UNIQUE INDEX `uidx_goods_receivings_org_client_req` ON `goods_receivings` (`organization_id`,`client_request_id`);--> statement-breakpoint
CREATE INDEX `idx_goods_receivings_store_sup` ON `goods_receivings` (`organization_id`,`store_id`,`supplier_id`,`created_at_ms`);--> statement-breakpoint
CREATE TABLE `goods_receiving_lines` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`store_id` text NOT NULL,
	`device_id` text NOT NULL,
	`hlc` text NOT NULL,
	`created_at_ms` integer NOT NULL,
	`receiving_id` text NOT NULL,
	`sort_order` integer NOT NULL,
	`product_id` text NOT NULL,
	`variant_id` text,
	`qty` integer NOT NULL,
	`cost_unknown` integer NOT NULL,
	`initial_total_cost` integer NOT NULL,
	`vat_rate_bp` integer,
	`vat_amount` integer,
	`stock_move_id` text NOT NULL,
	`batch_id` text,
	`batch_number` text,
	`expiry_date_ms` integer,
	FOREIGN KEY (`receiving_id`) REFERENCES `goods_receivings`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`product_id`) REFERENCES `products`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`variant_id`) REFERENCES `product_variants`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`stock_move_id`) REFERENCES `stock_moves`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`batch_id`) REFERENCES `batches`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "chk_goods_receiving_lines_hlc_len" CHECK(length("goods_receiving_lines"."hlc") = 58),
	CONSTRAINT "chk_goods_receiving_lines_created_at_ms_int" CHECK(typeof("goods_receiving_lines"."created_at_ms") = 'integer'),
	CONSTRAINT "chk_goods_receiving_lines_qty_int" CHECK(typeof("goods_receiving_lines"."qty") = 'integer'),
	CONSTRAINT "chk_goods_receiving_lines_initial_total_cost_int" CHECK(typeof("goods_receiving_lines"."initial_total_cost") = 'integer'),
	CONSTRAINT "chk_goods_receiving_lines_vat_amount_int" CHECK("goods_receiving_lines"."vat_amount" IS NULL OR typeof("goods_receiving_lines"."vat_amount") = 'integer'),
	CONSTRAINT "chk_goods_receiving_lines_expiry_date_ms_int" CHECK("goods_receiving_lines"."expiry_date_ms" IS NULL OR typeof("goods_receiving_lines"."expiry_date_ms") = 'integer'),
	CONSTRAINT "chk_goods_receiving_lines_sort_nonneg" CHECK("goods_receiving_lines"."sort_order" >= 0),
	CONSTRAINT "chk_goods_receiving_lines_qty_pos" CHECK("goods_receiving_lines"."qty" > 0),
	CONSTRAINT "chk_goods_receiving_lines_unk_bool" CHECK("goods_receiving_lines"."cost_unknown" IN (0, 1)),
	CONSTRAINT "chk_goods_receiving_lines_cost_pair" CHECK(("goods_receiving_lines"."cost_unknown" = 1 AND "goods_receiving_lines"."initial_total_cost" = 0) OR ("goods_receiving_lines"."cost_unknown" = 0 AND "goods_receiving_lines"."initial_total_cost" >= 0)),
	CONSTRAINT "chk_goods_receiving_lines_vat_bp" CHECK("goods_receiving_lines"."vat_rate_bp" IS NULL OR ("goods_receiving_lines"."vat_rate_bp" >= 0 AND "goods_receiving_lines"."vat_rate_bp" <= 10000)),
	CONSTRAINT "chk_goods_receiving_lines_vat_amt" CHECK("goods_receiving_lines"."vat_amount" IS NULL OR "goods_receiving_lines"."vat_amount" >= 0)
);--> statement-breakpoint
CREATE UNIQUE INDEX `uidx_goods_receiving_lines_sort` ON `goods_receiving_lines` (`receiving_id`,`sort_order`);--> statement-breakpoint
CREATE UNIQUE INDEX `uidx_goods_receiving_lines_move` ON `goods_receiving_lines` (`stock_move_id`);--> statement-breakpoint
CREATE INDEX `idx_goods_receiving_lines_rcv` ON `goods_receiving_lines` (`receiving_id`);--> statement-breakpoint
CREATE TABLE `receiving_cost_confirmations` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`store_id` text NOT NULL,
	`device_id` text NOT NULL,
	`hlc` text NOT NULL,
	`created_at_ms` integer NOT NULL,
	`receiving_id` text NOT NULL,
	`receiving_line_id` text NOT NULL,
	`supplier_id` text NOT NULL,
	`product_id` text NOT NULL,
	`variant_id` text,
	`batch_id` text,
	`received_qty` integer NOT NULL,
	`confirmed_total_cost` integer NOT NULL,
	`due_days` integer,
	`due_at_ms` integer,
	`reason` text NOT NULL,
	`confirmed_by_user_id` text NOT NULL,
	`client_request_id` text NOT NULL,
	`request_hash` text NOT NULL,
	FOREIGN KEY (`receiving_id`) REFERENCES `goods_receivings`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`receiving_line_id`) REFERENCES `goods_receiving_lines`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`supplier_id`) REFERENCES `suppliers`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`product_id`) REFERENCES `products`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`variant_id`) REFERENCES `product_variants`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`batch_id`) REFERENCES `batches`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`confirmed_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "chk_receiving_cost_confirmations_hlc_len" CHECK(length("receiving_cost_confirmations"."hlc") = 58),
	CONSTRAINT "chk_receiving_cost_confirmations_created_at_ms_int" CHECK(typeof("receiving_cost_confirmations"."created_at_ms") = 'integer'),
	CONSTRAINT "chk_receiving_cost_confirmations_received_qty_int" CHECK(typeof("receiving_cost_confirmations"."received_qty") = 'integer'),
	CONSTRAINT "chk_receiving_cost_confirmations_confirmed_total_cost_int" CHECK(typeof("receiving_cost_confirmations"."confirmed_total_cost") = 'integer'),
	CONSTRAINT "chk_receiving_cost_confirmations_due_at_ms_int" CHECK("receiving_cost_confirmations"."due_at_ms" IS NULL OR typeof("receiving_cost_confirmations"."due_at_ms") = 'integer'),
	CONSTRAINT "chk_receiving_cost_confirms_qty_pos" CHECK("receiving_cost_confirmations"."received_qty" > 0),
	CONSTRAINT "chk_receiving_cost_confirms_cost_nonneg" CHECK("receiving_cost_confirmations"."confirmed_total_cost" >= 0),
	CONSTRAINT "chk_receiving_cost_confirms_reason_nonempty" CHECK(length(trim("receiving_cost_confirmations"."reason")) >= 1),
	CONSTRAINT "chk_receiving_cost_confirms_req_hash_nonempty" CHECK(length(trim("receiving_cost_confirmations"."request_hash")) >= 6)
);--> statement-breakpoint
CREATE UNIQUE INDEX `uidx_receiving_cost_confirms_line` ON `receiving_cost_confirmations` (`organization_id`,`receiving_line_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `uidx_receiving_cost_confirms_client_req` ON `receiving_cost_confirmations` (`organization_id`,`client_request_id`);--> statement-breakpoint
CREATE INDEX `idx_receiving_cost_confirms_prod` ON `receiving_cost_confirmations` (`organization_id`,`store_id`,`product_id`,`hlc`);--> statement-breakpoint
CREATE TABLE `supplier_returns` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`store_id` text NOT NULL,
	`device_id` text NOT NULL,
	`hlc` text NOT NULL,
	`created_at_ms` integer NOT NULL,
	`return_no` integer NOT NULL,
	`return_code` text NOT NULL,
	`receiving_id` text NOT NULL,
	`supplier_id` text NOT NULL,
	`reason` text NOT NULL,
	`total_return_cost` integer NOT NULL,
	`created_by_user_id` text NOT NULL,
	`client_request_id` text NOT NULL,
	`request_hash` text NOT NULL,
	FOREIGN KEY (`receiving_id`) REFERENCES `goods_receivings`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`supplier_id`) REFERENCES `suppliers`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "chk_supplier_returns_hlc_len" CHECK(length("supplier_returns"."hlc") = 58),
	CONSTRAINT "chk_supplier_returns_created_at_ms_int" CHECK(typeof("supplier_returns"."created_at_ms") = 'integer'),
	CONSTRAINT "chk_supplier_returns_return_no_int" CHECK(typeof("supplier_returns"."return_no") = 'integer'),
	CONSTRAINT "chk_supplier_returns_total_return_cost_int" CHECK(typeof("supplier_returns"."total_return_cost") = 'integer'),
	CONSTRAINT "chk_supplier_returns_no_pos" CHECK("supplier_returns"."return_no" >= 1),
	CONSTRAINT "chk_supplier_returns_code_nonempty" CHECK(length(trim("supplier_returns"."return_code")) >= 1),
	CONSTRAINT "chk_supplier_returns_reason_nonempty" CHECK(length(trim("supplier_returns"."reason")) >= 1),
	CONSTRAINT "chk_supplier_returns_cost_nonneg" CHECK("supplier_returns"."total_return_cost" >= 0),
	CONSTRAINT "chk_supplier_returns_req_hash_nonempty" CHECK(length(trim("supplier_returns"."request_hash")) >= 6)
);--> statement-breakpoint
CREATE UNIQUE INDEX `uidx_supplier_returns_org_dev_no` ON `supplier_returns` (`organization_id`,`device_id`,`return_no`);--> statement-breakpoint
CREATE UNIQUE INDEX `uidx_supplier_returns_org_client_req` ON `supplier_returns` (`organization_id`,`client_request_id`);--> statement-breakpoint
CREATE INDEX `idx_supplier_returns_rcv` ON `supplier_returns` (`receiving_id`);--> statement-breakpoint
CREATE TABLE `supplier_return_lines` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`store_id` text NOT NULL,
	`device_id` text NOT NULL,
	`hlc` text NOT NULL,
	`created_at_ms` integer NOT NULL,
	`supplier_return_id` text NOT NULL,
	`receiving_line_id` text NOT NULL,
	`sort_order` integer NOT NULL,
	`product_id` text NOT NULL,
	`variant_id` text,
	`batch_id` text,
	`stock_move_id` text NOT NULL,
	`qty` integer NOT NULL,
	`return_cost_value` integer NOT NULL,
	FOREIGN KEY (`supplier_return_id`) REFERENCES `supplier_returns`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`receiving_line_id`) REFERENCES `goods_receiving_lines`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`product_id`) REFERENCES `products`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`variant_id`) REFERENCES `product_variants`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`batch_id`) REFERENCES `batches`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`stock_move_id`) REFERENCES `stock_moves`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "chk_supplier_return_lines_hlc_len" CHECK(length("supplier_return_lines"."hlc") = 58),
	CONSTRAINT "chk_supplier_return_lines_created_at_ms_int" CHECK(typeof("supplier_return_lines"."created_at_ms") = 'integer'),
	CONSTRAINT "chk_supplier_return_lines_qty_int" CHECK(typeof("supplier_return_lines"."qty") = 'integer'),
	CONSTRAINT "chk_supplier_return_lines_return_cost_value_int" CHECK(typeof("supplier_return_lines"."return_cost_value") = 'integer'),
	CONSTRAINT "chk_supplier_return_lines_sort_nonneg" CHECK("supplier_return_lines"."sort_order" >= 0),
	CONSTRAINT "chk_supplier_return_lines_qty_pos" CHECK("supplier_return_lines"."qty" > 0),
	CONSTRAINT "chk_supplier_return_lines_cost_nonneg" CHECK("supplier_return_lines"."return_cost_value" >= 0)
);--> statement-breakpoint
CREATE UNIQUE INDEX `uidx_supplier_return_lines_sort` ON `supplier_return_lines` (`supplier_return_id`,`sort_order`);--> statement-breakpoint
CREATE UNIQUE INDEX `uidx_supplier_return_lines_move` ON `supplier_return_lines` (`stock_move_id`);--> statement-breakpoint
CREATE INDEX `idx_supplier_return_lines_rcv_line` ON `supplier_return_lines` (`receiving_line_id`);--> statement-breakpoint
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
CREATE UNIQUE INDEX `uidx_supplier_ledger_opening_balance` ON `supplier_ledger` (`organization_id`,`supplier_id`) WHERE "supplier_ledger"."entry_type" = 'opening_balance';--> statement-breakpoint
CREATE UNIQUE INDEX `uidx_supplier_ledger_org_client_req` ON `supplier_ledger` (`organization_id`,`client_request_id`) WHERE "supplier_ledger"."client_request_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX `idx_supplier_ledger_org_sup_hlc` ON `supplier_ledger` (`organization_id`,`supplier_id`,`hlc`,`id`);--> statement-breakpoint
CREATE INDEX `idx_supplier_ledger_receiving` ON `supplier_ledger` (`receiving_id`) WHERE "supplier_ledger"."receiving_id" IS NOT NULL;--> statement-breakpoint
CREATE TABLE `local_supplier_balances` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`created_at_ms` integer NOT NULL,
	`updated_at_ms` integer NOT NULL,
	`supplier_id` text NOT NULL,
	`balance` integer NOT NULL,
	`total_debt_accrued` integer NOT NULL,
	`total_credited` integer NOT NULL,
	`earliest_open_due_at_ms` integer,
	`last_activity_at_ms` integer,
	FOREIGN KEY (`supplier_id`) REFERENCES `suppliers`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "chk_local_supplier_balances_created_at_ms_int" CHECK(typeof("local_supplier_balances"."created_at_ms") = 'integer'),
	CONSTRAINT "chk_local_supplier_balances_updated_at_ms_int" CHECK(typeof("local_supplier_balances"."updated_at_ms") = 'integer'),
	CONSTRAINT "chk_local_supplier_balances_balance_int" CHECK(typeof("local_supplier_balances"."balance") = 'integer'),
	CONSTRAINT "chk_local_supplier_balances_total_debt_accrued_int" CHECK(typeof("local_supplier_balances"."total_debt_accrued") = 'integer'),
	CONSTRAINT "chk_local_supplier_balances_total_credited_int" CHECK(typeof("local_supplier_balances"."total_credited") = 'integer'),
	CONSTRAINT "chk_local_supplier_balances_earliest_open_due_at_ms_int" CHECK("local_supplier_balances"."earliest_open_due_at_ms" IS NULL OR typeof("local_supplier_balances"."earliest_open_due_at_ms") = 'integer'),
	CONSTRAINT "chk_local_supplier_balances_last_activity_at_ms_int" CHECK("local_supplier_balances"."last_activity_at_ms" IS NULL OR typeof("local_supplier_balances"."last_activity_at_ms") = 'integer'),
	CONSTRAINT "chk_local_supplier_balances_accrued_nonneg" CHECK("local_supplier_balances"."total_debt_accrued" >= 0),
	CONSTRAINT "chk_local_supplier_balances_credited_nonneg" CHECK("local_supplier_balances"."total_credited" >= 0)
);--> statement-breakpoint
CREATE UNIQUE INDEX `uidx_local_supplier_balances_sup` ON `local_supplier_balances` (`supplier_id`);--> statement-breakpoint
CREATE INDEX `idx_local_supplier_balances_org_due` ON `local_supplier_balances` (`organization_id`,`balance`,`earliest_open_due_at_ms`,`supplier_id`);--> statement-breakpoint
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
DROP TRIGGER IF EXISTS "trg_stock_moves_no_update";--> statement-breakpoint
CREATE TRIGGER "trg_stock_moves_no_update"
BEFORE UPDATE ON "stock_moves"
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'FACT table "stock_moves" is immutable: UPDATE is forbidden');
END;--> statement-breakpoint
DROP TRIGGER IF EXISTS "trg_stock_moves_no_delete";--> statement-breakpoint
CREATE TRIGGER "trg_stock_moves_no_delete"
BEFORE DELETE ON "stock_moves"
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'FACT table "stock_moves" forbids physical DELETE: use tombstone');
END;--> statement-breakpoint
DROP TRIGGER IF EXISTS "trg_suppliers_no_delete";--> statement-breakpoint
CREATE TRIGGER "trg_suppliers_no_delete"
BEFORE DELETE ON "suppliers"
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'ATTR table "suppliers" forbids physical DELETE: use tombstone');
END;--> statement-breakpoint
DROP TRIGGER IF EXISTS "trg_goods_receivings_no_update";--> statement-breakpoint
CREATE TRIGGER "trg_goods_receivings_no_update"
BEFORE UPDATE ON "goods_receivings"
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'FACT table "goods_receivings" is immutable: UPDATE is forbidden');
END;--> statement-breakpoint
DROP TRIGGER IF EXISTS "trg_goods_receivings_no_delete";--> statement-breakpoint
CREATE TRIGGER "trg_goods_receivings_no_delete"
BEFORE DELETE ON "goods_receivings"
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'FACT table "goods_receivings" forbids physical DELETE: use tombstone');
END;--> statement-breakpoint
DROP TRIGGER IF EXISTS "trg_goods_receiving_lines_no_update";--> statement-breakpoint
CREATE TRIGGER "trg_goods_receiving_lines_no_update"
BEFORE UPDATE ON "goods_receiving_lines"
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'FACT table "goods_receiving_lines" is immutable: UPDATE is forbidden');
END;--> statement-breakpoint
DROP TRIGGER IF EXISTS "trg_goods_receiving_lines_no_delete";--> statement-breakpoint
CREATE TRIGGER "trg_goods_receiving_lines_no_delete"
BEFORE DELETE ON "goods_receiving_lines"
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'FACT table "goods_receiving_lines" forbids physical DELETE: use tombstone');
END;--> statement-breakpoint
DROP TRIGGER IF EXISTS "trg_receiving_cost_confirmations_no_update";--> statement-breakpoint
CREATE TRIGGER "trg_receiving_cost_confirmations_no_update"
BEFORE UPDATE ON "receiving_cost_confirmations"
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'FACT table "receiving_cost_confirmations" is immutable: UPDATE is forbidden');
END;--> statement-breakpoint
DROP TRIGGER IF EXISTS "trg_receiving_cost_confirmations_no_delete";--> statement-breakpoint
CREATE TRIGGER "trg_receiving_cost_confirmations_no_delete"
BEFORE DELETE ON "receiving_cost_confirmations"
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'FACT table "receiving_cost_confirmations" forbids physical DELETE: use tombstone');
END;--> statement-breakpoint
DROP TRIGGER IF EXISTS "trg_supplier_returns_no_update";--> statement-breakpoint
CREATE TRIGGER "trg_supplier_returns_no_update"
BEFORE UPDATE ON "supplier_returns"
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'FACT table "supplier_returns" is immutable: UPDATE is forbidden');
END;--> statement-breakpoint
DROP TRIGGER IF EXISTS "trg_supplier_returns_no_delete";--> statement-breakpoint
CREATE TRIGGER "trg_supplier_returns_no_delete"
BEFORE DELETE ON "supplier_returns"
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'FACT table "supplier_returns" forbids physical DELETE: use tombstone');
END;--> statement-breakpoint
DROP TRIGGER IF EXISTS "trg_supplier_return_lines_no_update";--> statement-breakpoint
CREATE TRIGGER "trg_supplier_return_lines_no_update"
BEFORE UPDATE ON "supplier_return_lines"
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'FACT table "supplier_return_lines" is immutable: UPDATE is forbidden');
END;--> statement-breakpoint
DROP TRIGGER IF EXISTS "trg_supplier_return_lines_no_delete";--> statement-breakpoint
CREATE TRIGGER "trg_supplier_return_lines_no_delete"
BEFORE DELETE ON "supplier_return_lines"
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'FACT table "supplier_return_lines" forbids physical DELETE: use tombstone');
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
DROP TRIGGER IF EXISTS "trg_suppliers_fts_after_insert";--> statement-breakpoint
DROP TRIGGER IF EXISTS "trg_suppliers_fts_after_update";--> statement-breakpoint
DROP TABLE IF EXISTS "suppliers_fts";--> statement-breakpoint
CREATE VIRTUAL TABLE "suppliers_fts" USING fts5(
  supplier_id UNINDEXED,
  organization_id UNINDEXED,
  name_search,
  phone_digits,
  tokenize = 'unicode61 remove_diacritics 0',
  prefix = '2 3'
);--> statement-breakpoint
CREATE TRIGGER "trg_suppliers_fts_after_insert"
AFTER INSERT ON "suppliers"
FOR EACH ROW
WHEN NEW."deleted_at_ms" IS NULL
BEGIN
  INSERT INTO "suppliers_fts" ("supplier_id", "organization_id", "name_search", "phone_digits")
  VALUES (NEW."id", NEW."organization_id", NEW."name_search", COALESCE(NEW."phone_digits", ''));
END;--> statement-breakpoint
CREATE TRIGGER "trg_suppliers_fts_after_update"
AFTER UPDATE ON "suppliers"
FOR EACH ROW
BEGIN
  DELETE FROM "suppliers_fts" WHERE "supplier_id" = OLD."id";
  INSERT INTO "suppliers_fts" ("supplier_id", "organization_id", "name_search", "phone_digits")
  SELECT NEW."id", NEW."organization_id", NEW."name_search", COALESCE(NEW."phone_digits", '')
  WHERE NEW."deleted_at_ms" IS NULL;
END;
