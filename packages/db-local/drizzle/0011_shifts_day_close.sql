CREATE TABLE `day_closes` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`store_id` text NOT NULL,
	`device_id` text NOT NULL,
	`hlc` text NOT NULL,
	`created_at_ms` integer NOT NULL,
	`business_date` text NOT NULL,
	`close_seq` integer NOT NULL,
	`close_code` text NOT NULL,
	`closed_by_user_id` text NOT NULL,
	`client_request_id` text NOT NULL,
	`request_hash` text NOT NULL,
	`note` text,
	`shifts_count` integer NOT NULL,
	`sales_count` integer NOT NULL,
	`returns_count` integer NOT NULL,
	`voids_count` integer NOT NULL,
	`gross_sales_total` integer NOT NULL,
	`returns_total` integer NOT NULL,
	`net_sales_total` integer NOT NULL,
	`expected_cash_total` integer NOT NULL,
	`counted_cash_total` integer NOT NULL,
	`discrepancy_total` integer NOT NULL,
	`method_totals_json` text NOT NULL,
	`included_closure_ids_json` text NOT NULL,
	`fiscal_status` text DEFAULT 'not_fiscalized' NOT NULL,
	`fiscal_report_no` text,
	FOREIGN KEY (`closed_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "chk_day_closes_hlc_len" CHECK(length("day_closes"."hlc") = 58),
	CONSTRAINT "chk_day_closes_created_at_ms_int" CHECK(typeof("day_closes"."created_at_ms") = 'integer'),
	CONSTRAINT "chk_day_closes_gross_sales_total_int" CHECK(typeof("day_closes"."gross_sales_total") = 'integer'),
	CONSTRAINT "chk_day_closes_returns_total_int" CHECK(typeof("day_closes"."returns_total") = 'integer'),
	CONSTRAINT "chk_day_closes_net_sales_total_int" CHECK(typeof("day_closes"."net_sales_total") = 'integer'),
	CONSTRAINT "chk_day_closes_expected_cash_total_int" CHECK(typeof("day_closes"."expected_cash_total") = 'integer'),
	CONSTRAINT "chk_day_closes_counted_cash_total_int" CHECK(typeof("day_closes"."counted_cash_total") = 'integer'),
	CONSTRAINT "chk_day_closes_discrepancy_total_int" CHECK(typeof("day_closes"."discrepancy_total") = 'integer'),
	CONSTRAINT "chk_day_closes_seq_pos" CHECK("day_closes"."close_seq" >= 1),
	CONSTRAINT "chk_day_closes_date_len" CHECK(length("day_closes"."business_date") = 10),
	CONSTRAINT "chk_day_closes_code_nonempty" CHECK(length(trim("day_closes"."close_code")) >= 1),
	CONSTRAINT "chk_day_closes_req_hash" CHECK(length(trim("day_closes"."request_hash")) >= 6),
	CONSTRAINT "chk_day_closes_fiscal_status" CHECK("day_closes"."fiscal_status" IN ('not_fiscalized', 'pending', 'fiscalized')),
	CONSTRAINT "chk_day_closes_nonneg" CHECK("day_closes"."shifts_count" >= 0 AND "day_closes"."sales_count" >= 0 AND "day_closes"."returns_count" >= 0 AND "day_closes"."voids_count" >= 0 AND "day_closes"."gross_sales_total" >= 0 AND "day_closes"."returns_total" >= 0 AND "day_closes"."counted_cash_total" >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uidx_day_closes_store_date_seq` ON `day_closes` (`organization_id`,`store_id`,`business_date`,`close_seq`);--> statement-breakpoint
CREATE UNIQUE INDEX `uidx_day_closes_org_req` ON `day_closes` (`organization_id`,`client_request_id`);--> statement-breakpoint
CREATE INDEX `idx_day_closes_store_date` ON `day_closes` (`organization_id`,`store_id`,`business_date`,`close_seq`);--> statement-breakpoint
CREATE TABLE `shift_cashier_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`store_id` text NOT NULL,
	`device_id` text NOT NULL,
	`hlc` text NOT NULL,
	`created_at_ms` integer NOT NULL,
	`updated_at_ms` integer NOT NULL,
	`shift_id` text NOT NULL,
	`session_seq` integer NOT NULL,
	`cashier_user_id` text NOT NULL,
	`status` text NOT NULL,
	`opening_float` integer NOT NULL,
	`expected_cash` integer,
	`counted_cash` integer,
	`discrepancy` integer,
	`discrepancy_reason` text,
	`denominations_json` text,
	`override_approved_by_user_id` text,
	`handed_off_by_user_id` text,
	`note` text,
	`started_at_ms` integer NOT NULL,
	`ended_at_ms` integer,
	`handoff_client_request_id` text,
	`handoff_request_hash` text,
	FOREIGN KEY (`shift_id`) REFERENCES `shifts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`cashier_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`override_approved_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`handed_off_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "chk_shift_cashier_sessions_hlc_len" CHECK(length("shift_cashier_sessions"."hlc") = 58),
	CONSTRAINT "chk_shift_cashier_sessions_created_at_ms_int" CHECK(typeof("shift_cashier_sessions"."created_at_ms") = 'integer'),
	CONSTRAINT "chk_shift_cashier_sessions_updated_at_ms_int" CHECK(typeof("shift_cashier_sessions"."updated_at_ms") = 'integer'),
	CONSTRAINT "chk_shift_cashier_sessions_opening_float_int" CHECK(typeof("shift_cashier_sessions"."opening_float") = 'integer'),
	CONSTRAINT "chk_shift_cashier_sessions_expected_cash_int" CHECK("shift_cashier_sessions"."expected_cash" IS NULL OR typeof("shift_cashier_sessions"."expected_cash") = 'integer'),
	CONSTRAINT "chk_shift_cashier_sessions_counted_cash_int" CHECK("shift_cashier_sessions"."counted_cash" IS NULL OR typeof("shift_cashier_sessions"."counted_cash") = 'integer'),
	CONSTRAINT "chk_shift_cashier_sessions_discrepancy_int" CHECK("shift_cashier_sessions"."discrepancy" IS NULL OR typeof("shift_cashier_sessions"."discrepancy") = 'integer'),
	CONSTRAINT "chk_shift_cashier_sessions_started_at_ms_int" CHECK(typeof("shift_cashier_sessions"."started_at_ms") = 'integer'),
	CONSTRAINT "chk_shift_cashier_sessions_ended_at_ms_int" CHECK("shift_cashier_sessions"."ended_at_ms" IS NULL OR typeof("shift_cashier_sessions"."ended_at_ms") = 'integer'),
	CONSTRAINT "chk_shift_cashier_seq_pos" CHECK("shift_cashier_sessions"."session_seq" >= 1),
	CONSTRAINT "chk_shift_cashier_status" CHECK("shift_cashier_sessions"."status" IN ('active', 'closed')),
	CONSTRAINT "chk_shift_cashier_float_nonneg" CHECK("shift_cashier_sessions"."opening_float" >= 0),
	CONSTRAINT "chk_shift_cashier_closed_fields" CHECK(("shift_cashier_sessions"."status" = 'active' AND "shift_cashier_sessions"."expected_cash" IS NULL AND "shift_cashier_sessions"."counted_cash" IS NULL AND "shift_cashier_sessions"."discrepancy" IS NULL AND "shift_cashier_sessions"."ended_at_ms" IS NULL) OR ("shift_cashier_sessions"."status" = 'closed' AND "shift_cashier_sessions"."expected_cash" IS NOT NULL AND "shift_cashier_sessions"."counted_cash" IS NOT NULL AND "shift_cashier_sessions"."counted_cash" >= 0 AND "shift_cashier_sessions"."discrepancy" IS NOT NULL AND "shift_cashier_sessions"."ended_at_ms" IS NOT NULL AND "shift_cashier_sessions"."ended_at_ms" >= "shift_cashier_sessions"."started_at_ms")),
	CONSTRAINT "chk_shift_cashier_handoff_req_pair" CHECK(("shift_cashier_sessions"."handoff_client_request_id" IS NULL AND "shift_cashier_sessions"."handoff_request_hash" IS NULL) OR ("shift_cashier_sessions"."handoff_client_request_id" IS NOT NULL AND "shift_cashier_sessions"."handoff_request_hash" IS NOT NULL AND length(trim("shift_cashier_sessions"."handoff_request_hash")) >= 6))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uidx_shift_cashier_sessions_shift_seq` ON `shift_cashier_sessions` (`shift_id`,`session_seq`);--> statement-breakpoint
CREATE UNIQUE INDEX `uidx_shift_cashier_one_active` ON `shift_cashier_sessions` (`shift_id`) WHERE "shift_cashier_sessions"."status" = 'active';--> statement-breakpoint
CREATE UNIQUE INDEX `uidx_shift_cashier_handoff_req` ON `shift_cashier_sessions` (`organization_id`,`handoff_client_request_id`) WHERE "shift_cashier_sessions"."handoff_client_request_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX `idx_shift_cashier_sessions_shift` ON `shift_cashier_sessions` (`shift_id`,`session_seq`);--> statement-breakpoint
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
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uidx_shift_closure_cashiers_sess` ON `shift_closure_cashiers` (`shift_closure_id`,`session_id`);--> statement-breakpoint
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
	CONSTRAINT "chk_shift_closure_methods_enum" CHECK("shift_closure_method_totals"."method" IN ('cash', 'card', 'uzqr', 'payme', 'click', 'uzum', 'social_card', 'other', 'debt')),
	CONSTRAINT "chk_shift_closure_methods_nonneg" CHECK("shift_closure_method_totals"."sales_amount" >= 0 AND "shift_closure_method_totals"."returns_amount" >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uidx_shift_closure_methods` ON `shift_closure_method_totals` (`shift_closure_id`,`method`);--> statement-breakpoint
CREATE TABLE `shift_closures` (
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
	FOREIGN KEY (`shift_id`) REFERENCES `shifts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`closed_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`override_approved_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "chk_shift_closures_hlc_len" CHECK(length("shift_closures"."hlc") = 58),
	CONSTRAINT "chk_shift_closures_created_at_ms_int" CHECK(typeof("shift_closures"."created_at_ms") = 'integer'),
	CONSTRAINT "chk_shift_closures_expected_cash_int" CHECK(typeof("shift_closures"."expected_cash") = 'integer'),
	CONSTRAINT "chk_shift_closures_counted_cash_int" CHECK(typeof("shift_closures"."counted_cash") = 'integer'),
	CONSTRAINT "chk_shift_closures_discrepancy_int" CHECK(typeof("shift_closures"."discrepancy") = 'integer'),
	CONSTRAINT "chk_shift_closures_gross_sales_total_int" CHECK(typeof("shift_closures"."gross_sales_total") = 'integer'),
	CONSTRAINT "chk_shift_closures_returns_total_int" CHECK(typeof("shift_closures"."returns_total") = 'integer'),
	CONSTRAINT "chk_shift_closures_net_sales_total_int" CHECK(typeof("shift_closures"."net_sales_total") = 'integer'),
	CONSTRAINT "chk_shift_closures_seq_pos" CHECK("shift_closures"."closure_seq" >= 1),
	CONSTRAINT "chk_shift_closures_reclose_bool" CHECK("shift_closures"."is_reclose" IN (0, 1)),
	CONSTRAINT "chk_shift_closures_reclose_reason" CHECK("shift_closures"."is_reclose" = 0 OR ("shift_closures"."reason" IS NOT NULL AND length(trim("shift_closures"."reason")) >= 1)),
	CONSTRAINT "chk_shift_closures_req_hash" CHECK(length(trim("shift_closures"."request_hash")) >= 6),
	CONSTRAINT "chk_shift_closures_money_nonneg" CHECK("shift_closures"."counted_cash" >= 0 AND "shift_closures"."gross_sales_total" >= 0 AND "shift_closures"."returns_total" >= 0),
	CONSTRAINT "chk_shift_closures_counts_nonneg" CHECK("shift_closures"."sales_count" >= 0 AND "shift_closures"."returns_count" >= 0 AND "shift_closures"."voids_count" >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uidx_shift_closures_shift_seq` ON `shift_closures` (`shift_id`,`closure_seq`);--> statement-breakpoint
CREATE UNIQUE INDEX `uidx_shift_closures_org_req` ON `shift_closures` (`organization_id`,`client_request_id`);--> statement-breakpoint
CREATE INDEX `idx_shift_closures_shift_seq` ON `shift_closures` (`shift_id`,`closure_seq`);--> statement-breakpoint
CREATE TABLE `shifts` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`store_id` text NOT NULL,
	`device_id` text NOT NULL,
	`hlc` text NOT NULL,
	`created_at_ms` integer NOT NULL,
	`updated_at_ms` integer NOT NULL,
	`shift_no` integer NOT NULL,
	`shift_code` text NOT NULL,
	`status` text NOT NULL,
	`opened_by_user_id` text NOT NULL,
	`closed_by_user_id` text,
	`opening_cash` integer NOT NULL,
	`previous_close_cash` integer,
	`opening_discrepancy` integer DEFAULT 0 NOT NULL,
	`opening_discrepancy_reason` text,
	`opening_note` text,
	`closing_note` text,
	`opened_at_ms` integer NOT NULL,
	`closed_at_ms` integer,
	`open_client_request_id` text NOT NULL,
	`open_request_hash` text NOT NULL,
	`close_client_request_id` text,
	`close_request_hash` text,
	FOREIGN KEY (`opened_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`closed_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "chk_shifts_hlc_len" CHECK(length("shifts"."hlc") = 58),
	CONSTRAINT "chk_shifts_created_at_ms_int" CHECK(typeof("shifts"."created_at_ms") = 'integer'),
	CONSTRAINT "chk_shifts_updated_at_ms_int" CHECK(typeof("shifts"."updated_at_ms") = 'integer'),
	CONSTRAINT "chk_shifts_shift_no_int" CHECK(typeof("shifts"."shift_no") = 'integer'),
	CONSTRAINT "chk_shifts_opening_cash_int" CHECK(typeof("shifts"."opening_cash") = 'integer'),
	CONSTRAINT "chk_shifts_previous_close_cash_int" CHECK("shifts"."previous_close_cash" IS NULL OR typeof("shifts"."previous_close_cash") = 'integer'),
	CONSTRAINT "chk_shifts_opening_discrepancy_int" CHECK(typeof("shifts"."opening_discrepancy") = 'integer'),
	CONSTRAINT "chk_shifts_opened_at_ms_int" CHECK(typeof("shifts"."opened_at_ms") = 'integer'),
	CONSTRAINT "chk_shifts_closed_at_ms_int" CHECK("shifts"."closed_at_ms" IS NULL OR typeof("shifts"."closed_at_ms") = 'integer'),
	CONSTRAINT "chk_shifts_no_pos" CHECK("shifts"."shift_no" >= 1),
	CONSTRAINT "chk_shifts_code_nonempty" CHECK(length(trim("shifts"."shift_code")) >= 1),
	CONSTRAINT "chk_shifts_status" CHECK("shifts"."status" IN ('open', 'closed')),
	CONSTRAINT "chk_shifts_opening_nonneg" CHECK("shifts"."opening_cash" >= 0 AND ("shifts"."previous_close_cash" IS NULL OR "shifts"."previous_close_cash" >= 0)),
	CONSTRAINT "chk_shifts_open_req_hash" CHECK(length(trim("shifts"."open_request_hash")) >= 6),
	CONSTRAINT "chk_shifts_open_closed_pair" CHECK(("shifts"."status" = 'open' AND "shifts"."closed_at_ms" IS NULL AND "shifts"."closed_by_user_id" IS NULL AND "shifts"."close_client_request_id" IS NULL AND "shifts"."close_request_hash" IS NULL) OR ("shifts"."status" = 'closed' AND "shifts"."closed_at_ms" IS NOT NULL AND "shifts"."closed_by_user_id" IS NOT NULL AND "shifts"."close_client_request_id" IS NOT NULL AND "shifts"."close_request_hash" IS NOT NULL AND length(trim("shifts"."close_request_hash")) >= 6 AND "shifts"."closed_at_ms" >= "shifts"."opened_at_ms"))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uidx_shifts_org_device_no` ON `shifts` (`organization_id`,`device_id`,`shift_no`);--> statement-breakpoint
CREATE UNIQUE INDEX `uidx_shifts_one_open_per_device` ON `shifts` (`organization_id`,`store_id`,`device_id`) WHERE "shifts"."status" = 'open';--> statement-breakpoint
CREATE UNIQUE INDEX `uidx_shifts_org_open_req` ON `shifts` (`organization_id`,`open_client_request_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `uidx_shifts_org_close_req` ON `shifts` (`organization_id`,`close_client_request_id`) WHERE "shifts"."close_client_request_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX `idx_shifts_store_closed` ON `shifts` (`organization_id`,`store_id`,`status`,`closed_at_ms`);--> statement-breakpoint
CREATE INDEX `idx_shifts_store_opened` ON `shifts` (`organization_id`,`store_id`,`status`,`opened_at_ms`);--> statement-breakpoint
ALTER TABLE `cash_moves` ADD `shift_cashier_session_id` text;--> statement-breakpoint
ALTER TABLE `cash_moves` ADD `expense_category` text;--> statement-breakpoint
CREATE INDEX `idx_cash_moves_session` ON `cash_moves` (`shift_cashier_session_id`);--> statement-breakpoint
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
	CONSTRAINT "chk_local_device_state_last_hlc_len" CHECK(length("__new_local_device_state"."last_hlc") = 58),
	CONSTRAINT "chk_local_device_state_last_uuid_ms_int" CHECK(typeof("__new_local_device_state"."last_uuid_ms") = 'integer'),
	CONSTRAINT "chk_local_device_state_seq_nonneg" CHECK("__new_local_device_state"."last_device_seq" >= 0),
	CONSTRAINT "chk_local_device_state_receipt_nonneg" CHECK("__new_local_device_state"."last_receipt_seq" >= 0),
	CONSTRAINT "chk_local_device_state_return_nonneg" CHECK("__new_local_device_state"."last_return_seq" >= 0),
	CONSTRAINT "chk_local_device_state_receiving_nonneg" CHECK("__new_local_device_state"."last_receiving_seq" >= 0),
	CONSTRAINT "chk_local_device_state_sup_return_nonneg" CHECK("__new_local_device_state"."last_supplier_return_seq" >= 0),
	CONSTRAINT "chk_local_device_state_shift_nonneg" CHECK("__new_local_device_state"."last_shift_seq" >= 0)
);
--> statement-breakpoint
INSERT INTO `__new_local_device_state`("id", "organization_id", "created_at_ms", "updated_at_ms", "device_id", "last_device_seq", "last_receipt_seq", "last_return_seq", "last_receiving_seq", "last_supplier_return_seq", "last_shift_seq", "last_hlc", "last_uuid_ms") SELECT "id", "organization_id", "created_at_ms", "updated_at_ms", "device_id", "last_device_seq", "last_receipt_seq", "last_return_seq", "last_receiving_seq", "last_supplier_return_seq", 0, "last_hlc", "last_uuid_ms" FROM `local_device_state`;--> statement-breakpoint
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
	`max_cash_discrepancy_without_override` integer DEFAULT 1000000 NOT NULL,
	CONSTRAINT "chk_local_hub_config_created_at_ms_int" CHECK(typeof("__new_local_hub_config"."created_at_ms") = 'integer'),
	CONSTRAINT "chk_local_hub_config_updated_at_ms_int" CHECK(typeof("__new_local_hub_config"."updated_at_ms") = 'integer'),
	CONSTRAINT "chk_local_hub_config_setup_completed_at_ms_int" CHECK(typeof("__new_local_hub_config"."setup_completed_at_ms") = 'integer'),
	CONSTRAINT "chk_local_hub_config_cashier_max_discount_amount_int" CHECK(typeof("__new_local_hub_config"."cashier_max_discount_amount") = 'integer'),
	CONSTRAINT "chk_local_hub_config_max_cash_discrepancy_without_override_int" CHECK(typeof("__new_local_hub_config"."max_cash_discrepancy_without_override") = 'integer'),
	CONSTRAINT "chk_local_hub_config_singleton" CHECK("__new_local_hub_config"."singleton_guard" = 1),
	CONSTRAINT "chk_local_hub_config_neg_policy" CHECK("__new_local_hub_config"."negative_stock_policy" IN ('warn', 'block')),
	CONSTRAINT "chk_local_hub_config_pct_unlim" CHECK("__new_local_hub_config"."cashier_discount_percent_unlimited" IN (0, 1)),
	CONSTRAINT "chk_local_hub_config_max_pct" CHECK("__new_local_hub_config"."cashier_max_discount_percent_bp" >= 0 AND "__new_local_hub_config"."cashier_max_discount_percent_bp" <= 10000),
	CONSTRAINT "chk_local_hub_config_amt_unlim" CHECK("__new_local_hub_config"."cashier_discount_amount_unlimited" IN (0, 1)),
	CONSTRAINT "chk_local_hub_config_max_amt" CHECK("__new_local_hub_config"."cashier_max_discount_amount" >= 0),
	CONSTRAINT "chk_local_hub_config_qs_vat" CHECK("__new_local_hub_config"."quick_sale_default_vat_rate_bp" IS NULL OR ("__new_local_hub_config"."quick_sale_default_vat_rate_bp" >= 0 AND "__new_local_hub_config"."quick_sale_default_vat_rate_bp" <= 10000)),
	CONSTRAINT "chk_local_hub_config_timezone_nonempty" CHECK(length(trim("__new_local_hub_config"."store_timezone")) >= 1),
	CONSTRAINT "chk_local_hub_config_cust_due_days" CHECK("__new_local_hub_config"."default_customer_due_days" IS NULL OR ("__new_local_hub_config"."default_customer_due_days" >= 1 AND "__new_local_hub_config"."default_customer_due_days" <= 3650)),
	CONSTRAINT "chk_local_hub_config_sup_due_days" CHECK("__new_local_hub_config"."default_supplier_due_days" IS NULL OR ("__new_local_hub_config"."default_supplier_due_days" >= 1 AND "__new_local_hub_config"."default_supplier_due_days" <= 3650)),
	CONSTRAINT "chk_local_hub_config_max_cash_disc" CHECK("__new_local_hub_config"."max_cash_discrepancy_without_override" >= 0)
);
--> statement-breakpoint
INSERT INTO `__new_local_hub_config`("id", "organization_id", "created_at_ms", "updated_at_ms", "store_id", "device_id", "singleton_guard", "setup_completed_at_ms", "negative_stock_policy", "cashier_discount_percent_unlimited", "cashier_max_discount_percent_bp", "cashier_discount_amount_unlimited", "cashier_max_discount_amount", "quick_sale_default_mxik", "quick_sale_default_vat_rate_bp", "store_timezone", "default_customer_due_days", "default_supplier_due_days", "max_cash_discrepancy_without_override") SELECT "id", "organization_id", "created_at_ms", "updated_at_ms", "store_id", "device_id", "singleton_guard", "setup_completed_at_ms", "negative_stock_policy", "cashier_discount_percent_unlimited", "cashier_max_discount_percent_bp", "cashier_discount_amount_unlimited", "cashier_max_discount_amount", "quick_sale_default_mxik", "quick_sale_default_vat_rate_bp", "store_timezone", "default_customer_due_days", "default_supplier_due_days", 1000000 FROM `local_hub_config`;--> statement-breakpoint
DROP TABLE `local_hub_config`;--> statement-breakpoint
ALTER TABLE `__new_local_hub_config` RENAME TO `local_hub_config`;--> statement-breakpoint
CREATE UNIQUE INDEX `uidx_local_hub_config_singleton` ON `local_hub_config` (`singleton_guard`);--> statement-breakpoint
ALTER TABLE `returns` ADD `shift_id` text;--> statement-breakpoint
ALTER TABLE `returns` ADD `shift_cashier_session_id` text;--> statement-breakpoint
CREATE INDEX `idx_returns_shift_created` ON `returns` (`shift_id`,`created_at_ms`);--> statement-breakpoint
CREATE INDEX `idx_returns_session` ON `returns` (`shift_cashier_session_id`);--> statement-breakpoint
ALTER TABLE `sales` ADD `shift_cashier_session_id` text;--> statement-breakpoint
CREATE INDEX `idx_sales_shift_created` ON `sales` (`shift_id`,`created_at_ms`);--> statement-breakpoint
CREATE INDEX `idx_sales_session` ON `sales` (`shift_cashier_session_id`);--> statement-breakpoint
DROP TRIGGER IF EXISTS "trg_shifts_no_delete";--> statement-breakpoint
CREATE TRIGGER "trg_shifts_no_delete"
BEFORE DELETE ON "shifts"
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'MONOTONE table "shifts" forbids physical DELETE: use tombstone');
END;--> statement-breakpoint
DROP TRIGGER IF EXISTS "trg_shift_cashier_sessions_no_delete";--> statement-breakpoint
CREATE TRIGGER "trg_shift_cashier_sessions_no_delete"
BEFORE DELETE ON "shift_cashier_sessions"
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'MONOTONE table "shift_cashier_sessions" forbids physical DELETE: use tombstone');
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
END;--> statement-breakpoint
DROP TRIGGER IF EXISTS "trg_day_closes_no_update";--> statement-breakpoint
CREATE TRIGGER "trg_day_closes_no_update"
BEFORE UPDATE ON "day_closes"
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'FACT table "day_closes" is immutable: UPDATE is forbidden');
END;--> statement-breakpoint
DROP TRIGGER IF EXISTS "trg_day_closes_no_delete";--> statement-breakpoint
CREATE TRIGGER "trg_day_closes_no_delete"
BEFORE DELETE ON "day_closes"
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'FACT table "day_closes" forbids physical DELETE: use tombstone');
END;--> statement-breakpoint
DROP TRIGGER IF EXISTS "trg_sales_voided_monotone";--> statement-breakpoint
DROP TRIGGER IF EXISTS "trg_sales_immutable_core";--> statement-breakpoint
CREATE TRIGGER "trg_sales_voided_monotone"
BEFORE UPDATE ON "sales"
FOR EACH ROW
WHEN OLD."voided_at_ms" IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'MONOTONE table "sales" cannot be modified once voided');
END;--> statement-breakpoint
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
DROP TRIGGER IF EXISTS "trg_shifts_closed_monotone";--> statement-breakpoint
DROP TRIGGER IF EXISTS "trg_shifts_immutable_core";--> statement-breakpoint
CREATE TRIGGER "trg_shifts_closed_monotone"
BEFORE UPDATE ON "shifts"
FOR EACH ROW
WHEN OLD."status" = 'closed' OR OLD."closed_at_ms" IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'MONOTONE table "shifts" cannot be modified once closed');
END;--> statement-breakpoint
CREATE TRIGGER "trg_shifts_immutable_core"
BEFORE UPDATE ON "shifts"
FOR EACH ROW
WHEN
  OLD."status" = 'open' AND (
  NEW."status" <> 'closed' OR
  NEW."closed_at_ms" IS NULL OR
  NEW."closed_by_user_id" IS NULL OR
  NEW."close_client_request_id" IS NULL OR
  NEW."close_request_hash" IS NULL OR
  length(trim(NEW."close_request_hash")) < 6 OR
  OLD."closed_by_user_id" IS NOT NULL OR
  OLD."close_client_request_id" IS NOT NULL OR
  OLD."close_request_hash" IS NOT NULL OR
  NEW."id" IS NOT OLD."id" OR
  NEW."organization_id" IS NOT OLD."organization_id" OR
  NEW."store_id" IS NOT OLD."store_id" OR
  NEW."shift_no" IS NOT OLD."shift_no" OR
  NEW."shift_code" IS NOT OLD."shift_code" OR
  NEW."opened_by_user_id" IS NOT OLD."opened_by_user_id" OR
  NEW."opening_cash" IS NOT OLD."opening_cash" OR
  NEW."previous_close_cash" IS NOT OLD."previous_close_cash" OR
  NEW."opening_discrepancy" IS NOT OLD."opening_discrepancy" OR
  NEW."opening_discrepancy_reason" IS NOT OLD."opening_discrepancy_reason" OR
  NEW."opening_note" IS NOT OLD."opening_note" OR
  NEW."opened_at_ms" IS NOT OLD."opened_at_ms" OR
  NEW."open_client_request_id" IS NOT OLD."open_client_request_id" OR
  NEW."open_request_hash" IS NOT OLD."open_request_hash" OR
  NEW."created_at_ms" IS NOT OLD."created_at_ms")
BEGIN
  SELECT RAISE(ABORT, 'MONOTONE table "shifts" forbids mutating immutable open fields');
END;--> statement-breakpoint
DROP TRIGGER IF EXISTS "trg_shift_cashier_sessions_closed_monotone";--> statement-breakpoint
DROP TRIGGER IF EXISTS "trg_shift_cashier_sessions_immutable_core";--> statement-breakpoint
CREATE TRIGGER "trg_shift_cashier_sessions_closed_monotone"
BEFORE UPDATE ON "shift_cashier_sessions"
FOR EACH ROW
WHEN OLD."status" = 'closed' OR OLD."ended_at_ms" IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'MONOTONE table "shift_cashier_sessions" cannot be modified once closed');
END;--> statement-breakpoint
CREATE TRIGGER "trg_shift_cashier_sessions_immutable_core"
BEFORE UPDATE ON "shift_cashier_sessions"
FOR EACH ROW
WHEN
  OLD."status" = 'active' AND (
  NEW."status" <> 'closed' OR
  NEW."ended_at_ms" IS NULL OR
  NEW."expected_cash" IS NULL OR
  NEW."counted_cash" IS NULL OR
  NEW."discrepancy" IS NULL OR
  NEW."id" IS NOT OLD."id" OR
  NEW."organization_id" IS NOT OLD."organization_id" OR
  NEW."store_id" IS NOT OLD."store_id" OR
  NEW."shift_id" IS NOT OLD."shift_id" OR
  NEW."session_seq" IS NOT OLD."session_seq" OR
  NEW."cashier_user_id" IS NOT OLD."cashier_user_id" OR
  NEW."opening_float" IS NOT OLD."opening_float" OR
  NEW."started_at_ms" IS NOT OLD."started_at_ms" OR
  NEW."created_at_ms" IS NOT OLD."created_at_ms")
BEGIN
  SELECT RAISE(ABORT, 'MONOTONE table "shift_cashier_sessions" forbids mutating immutable session fields');
END;--> statement-breakpoint
DROP TRIGGER IF EXISTS "trg_sales_closed_shift_guard";--> statement-breakpoint
-- X5 (F2 sync note): Blocks local POS/hub inserts into an already-closed shift.
-- When F2 adds remote peer/cloud sync writes, update this trigger WHEN clause to permit
-- explicit F2 sync-mode inserts so historical receipts for closed shifts can sync safely.
CREATE TRIGGER "trg_sales_closed_shift_guard"
BEFORE INSERT ON "sales"
FOR EACH ROW
WHEN NEW."shift_id" IS NOT NULL AND EXISTS (
  SELECT 1 FROM "shifts" sh WHERE sh."id" = NEW."shift_id" AND sh."status" = 'closed'
)
BEGIN
  SELECT RAISE(ABORT, 'Cannot insert into "sales" referencing an already closed shift');
END;--> statement-breakpoint
DROP TRIGGER IF EXISTS "trg_returns_closed_shift_guard";--> statement-breakpoint
-- X5 (F2 sync note): Blocks local POS/hub inserts into an already-closed shift.
-- When F2 adds remote peer/cloud sync writes, update this trigger WHEN clause to permit
-- explicit F2 sync-mode inserts so historical receipts for closed shifts can sync safely.
CREATE TRIGGER "trg_returns_closed_shift_guard"
BEFORE INSERT ON "returns"
FOR EACH ROW
WHEN NEW."shift_id" IS NOT NULL AND EXISTS (
  SELECT 1 FROM "shifts" sh WHERE sh."id" = NEW."shift_id" AND sh."status" = 'closed'
)
BEGIN
  SELECT RAISE(ABORT, 'Cannot insert into "returns" referencing an already closed shift');
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
DROP VIEW IF EXISTS "v_sales_lines";--> statement-breakpoint
CREATE VIEW "v_sales_lines" AS
SELECT
  sl."organization_id" AS "organization_id",
  sl."store_id" AS "store_id",
  sl."device_id" AS "device_id",
  s."shift_id" AS "shift_id",
  s."shift_cashier_session_id" AS "shift_cashier_session_id",
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
  r."shift_id" AS "shift_id",
  r."shift_cashier_session_id" AS "shift_cashier_session_id",
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
