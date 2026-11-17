CREATE TABLE `fiscal_docs` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`store_id` text NOT NULL,
	`device_id` text NOT NULL,
	`hlc` text NOT NULL,
	`created_at_ms` integer NOT NULL,
	`updated_at_ms` integer NOT NULL,
	`doc_kind` text NOT NULL,
	`sale_id` text,
	`return_id` text,
	`shift_id` text,
	`depends_on_doc_id` text,
	`idempotency_key` text NOT NULL,
	`status` text NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`next_check_at_ms` integer NOT NULL,
	`last_error_code` text,
	`last_error_message` text,
	`sent_at_ms` integer,
	`confirmed_at_ms` integer,
	`cancelled_at_ms` integer,
	`fiscal_sign` text,
	`fiscal_number` text,
	`qr_payload` text,
	`driver_id` text NOT NULL,
	`offline_deadline_ms` integer NOT NULL,
	FOREIGN KEY (`sale_id`) REFERENCES `sales`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`return_id`) REFERENCES `returns`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`shift_id`) REFERENCES `shifts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`depends_on_doc_id`) REFERENCES `fiscal_docs`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "chk_fiscal_docs_hlc_len" CHECK(length("fiscal_docs"."hlc") = 58),
	CONSTRAINT "chk_fiscal_docs_created_at_ms_int" CHECK(typeof("fiscal_docs"."created_at_ms") = 'integer'),
	CONSTRAINT "chk_fiscal_docs_updated_at_ms_int" CHECK(typeof("fiscal_docs"."updated_at_ms") = 'integer'),
	CONSTRAINT "chk_fiscal_docs_next_check_at_ms_int" CHECK(typeof("fiscal_docs"."next_check_at_ms") = 'integer'),
	CONSTRAINT "chk_fiscal_docs_sent_at_ms_int" CHECK("fiscal_docs"."sent_at_ms" IS NULL OR typeof("fiscal_docs"."sent_at_ms") = 'integer'),
	CONSTRAINT "chk_fiscal_docs_confirmed_at_ms_int" CHECK("fiscal_docs"."confirmed_at_ms" IS NULL OR typeof("fiscal_docs"."confirmed_at_ms") = 'integer'),
	CONSTRAINT "chk_fiscal_docs_cancelled_at_ms_int" CHECK("fiscal_docs"."cancelled_at_ms" IS NULL OR typeof("fiscal_docs"."cancelled_at_ms") = 'integer'),
	CONSTRAINT "chk_fiscal_docs_offline_deadline_ms_int" CHECK(typeof("fiscal_docs"."offline_deadline_ms") = 'integer'),
	CONSTRAINT "chk_fiscal_docs_kind" CHECK("fiscal_docs"."doc_kind" IN ('sale', 'refund', 'shift_open', 'shift_close')),
	CONSTRAINT "chk_fiscal_docs_status" CHECK("fiscal_docs"."status" IN ('pending', 'sent', 'confirmed', 'failed', 'rejected', 'cancelled')),
	CONSTRAINT "chk_fiscal_docs_kind_refs" CHECK(("fiscal_docs"."doc_kind" = 'sale' AND "fiscal_docs"."sale_id" IS NOT NULL AND "fiscal_docs"."return_id" IS NULL AND "fiscal_docs"."shift_id" IS NULL AND "fiscal_docs"."depends_on_doc_id" IS NULL) OR ("fiscal_docs"."doc_kind" = 'refund' AND "fiscal_docs"."sale_id" IS NOT NULL AND "fiscal_docs"."return_id" IS NOT NULL AND "fiscal_docs"."shift_id" IS NULL) OR ("fiscal_docs"."doc_kind" IN ('shift_open', 'shift_close') AND "fiscal_docs"."shift_id" IS NOT NULL AND "fiscal_docs"."sale_id" IS NULL AND "fiscal_docs"."return_id" IS NULL AND "fiscal_docs"."depends_on_doc_id" IS NULL)),
	CONSTRAINT "chk_fiscal_docs_idem_nonempty" CHECK(length(trim("fiscal_docs"."idempotency_key")) >= 1),
	CONSTRAINT "chk_fiscal_docs_driver_nonempty" CHECK(length(trim("fiscal_docs"."driver_id")) >= 1),
	CONSTRAINT "chk_fiscal_docs_attempts" CHECK("fiscal_docs"."attempts" >= 0),
	CONSTRAINT "chk_fiscal_docs_confirmed_fields" CHECK(("fiscal_docs"."status" = 'confirmed' AND "fiscal_docs"."fiscal_sign" IS NOT NULL AND length(trim("fiscal_docs"."fiscal_sign")) >= 1 AND "fiscal_docs"."fiscal_number" IS NOT NULL AND length(trim("fiscal_docs"."fiscal_number")) >= 1 AND "fiscal_docs"."qr_payload" IS NOT NULL AND length("fiscal_docs"."qr_payload") >= 1 AND "fiscal_docs"."confirmed_at_ms" IS NOT NULL AND "fiscal_docs"."sent_at_ms" IS NOT NULL) OR ("fiscal_docs"."status" <> 'confirmed' AND "fiscal_docs"."fiscal_sign" IS NULL AND "fiscal_docs"."fiscal_number" IS NULL AND "fiscal_docs"."qr_payload" IS NULL AND "fiscal_docs"."confirmed_at_ms" IS NULL)),
	CONSTRAINT "chk_fiscal_docs_sent_at" CHECK("fiscal_docs"."status" NOT IN ('sent', 'rejected') OR "fiscal_docs"."sent_at_ms" IS NOT NULL),
	CONSTRAINT "chk_fiscal_docs_cancelled_at" CHECK(("fiscal_docs"."status" = 'cancelled') = ("fiscal_docs"."cancelled_at_ms" IS NOT NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uidx_fiscal_docs_org_idem` ON `fiscal_docs` (`organization_id`,`idempotency_key`);--> statement-breakpoint
CREATE UNIQUE INDEX `uidx_fiscal_docs_sale` ON `fiscal_docs` (`sale_id`) WHERE "fiscal_docs"."doc_kind" = 'sale';--> statement-breakpoint
CREATE UNIQUE INDEX `uidx_fiscal_docs_return` ON `fiscal_docs` (`return_id`) WHERE "fiscal_docs"."return_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX `idx_fiscal_docs_queue` ON `fiscal_docs` (`organization_id`,`status`,`next_check_at_ms`);--> statement-breakpoint
CREATE INDEX `idx_fiscal_docs_sale_lookup` ON `fiscal_docs` (`sale_id`);--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
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
	`printer_mode` text DEFAULT 'disabled' NOT NULL,
	`printer_name` text,
	`printer_host` text,
	`printer_port` integer DEFAULT 9100 NOT NULL,
	`printer_timeout_ms` integer DEFAULT 3000 NOT NULL,
	`printer_paper_width_mm` integer DEFAULT 80 NOT NULL,
	`printer_encoding` text DEFAULT 'translit' NOT NULL,
	`printer_auto_print_sale` integer DEFAULT true NOT NULL,
	`printer_cash_drawer_auto_open` integer DEFAULT true NOT NULL,
	`receipt_header_title` text DEFAULT 'GUZAR KASSA' NOT NULL,
	`receipt_footer_text` text DEFAULT 'Xaridingiz uchun rahmat!' NOT NULL,
	`max_rule_package_version` integer DEFAULT 0 NOT NULL,
	`fiscal_mode_enabled` integer DEFAULT false NOT NULL,
	`fiscal_offline_window_ms` integer DEFAULT 86400000 NOT NULL,
	`fiscal_block_on_offline_expired` integer DEFAULT false NOT NULL,
	`fiscal_require_open_shift` integer DEFAULT false NOT NULL,
	`fiscal_receipt_fields_json` text DEFAULT '[]' NOT NULL,
	`fiscal_driver_id` text DEFAULT 'fake' NOT NULL,
	CONSTRAINT "chk_local_hub_config_created_at_ms_int" CHECK(typeof("__new_local_hub_config"."created_at_ms") = 'integer'),
	CONSTRAINT "chk_local_hub_config_updated_at_ms_int" CHECK(typeof("__new_local_hub_config"."updated_at_ms") = 'integer'),
	CONSTRAINT "chk_local_hub_config_setup_completed_at_ms_int" CHECK(typeof("__new_local_hub_config"."setup_completed_at_ms") = 'integer'),
	CONSTRAINT "chk_local_hub_config_cashier_max_discount_amount_int" CHECK(typeof("__new_local_hub_config"."cashier_max_discount_amount") = 'integer'),
	CONSTRAINT "chk_local_hub_config_max_cash_discrepancy_without_override_int" CHECK(typeof("__new_local_hub_config"."max_cash_discrepancy_without_override") = 'integer'),
	CONSTRAINT "chk_local_hub_config_max_rule_package_version_int" CHECK(typeof("__new_local_hub_config"."max_rule_package_version") = 'integer'),
	CONSTRAINT "chk_local_hub_config_fiscal_offline_window_ms_int" CHECK(typeof("__new_local_hub_config"."fiscal_offline_window_ms") = 'integer'),
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
	CONSTRAINT "chk_local_hub_config_max_cash_disc" CHECK("__new_local_hub_config"."max_cash_discrepancy_without_override" >= 0),
	CONSTRAINT "chk_local_hub_config_printer_mode" CHECK("__new_local_hub_config"."printer_mode" IN ('disabled', 'windows_raw', 'network_tcp')),
	CONSTRAINT "chk_local_hub_config_printer_port" CHECK("__new_local_hub_config"."printer_port" >= 1 AND "__new_local_hub_config"."printer_port" <= 65535),
	CONSTRAINT "chk_local_hub_config_printer_timeout" CHECK("__new_local_hub_config"."printer_timeout_ms" >= 200 AND "__new_local_hub_config"."printer_timeout_ms" <= 30000),
	CONSTRAINT "chk_local_hub_config_printer_width" CHECK("__new_local_hub_config"."printer_paper_width_mm" IN (58, 80)),
	CONSTRAINT "chk_local_hub_config_printer_enc" CHECK("__new_local_hub_config"."printer_encoding" IN ('translit', 'cp866', 'cp1251')),
	CONSTRAINT "chk_local_hub_config_auto_print" CHECK("__new_local_hub_config"."printer_auto_print_sale" IN (0, 1)),
	CONSTRAINT "chk_local_hub_config_drawer_auto" CHECK("__new_local_hub_config"."printer_cash_drawer_auto_open" IN (0, 1)),
	CONSTRAINT "chk_local_hub_config_max_rule_ver" CHECK("__new_local_hub_config"."max_rule_package_version" >= 0),
	CONSTRAINT "chk_local_hub_config_fiscal_mode" CHECK("__new_local_hub_config"."fiscal_mode_enabled" IN (0, 1)),
	CONSTRAINT "chk_local_hub_config_fiscal_window" CHECK("__new_local_hub_config"."fiscal_offline_window_ms" >= 60000),
	CONSTRAINT "chk_local_hub_config_fiscal_block_exp" CHECK("__new_local_hub_config"."fiscal_block_on_offline_expired" IN (0, 1)),
	CONSTRAINT "chk_local_hub_config_fiscal_driver" CHECK(length(trim("__new_local_hub_config"."fiscal_driver_id")) >= 1),
	CONSTRAINT "chk_local_hub_config_fiscal_req_shift" CHECK("__new_local_hub_config"."fiscal_require_open_shift" IN (0, 1))
);
--> statement-breakpoint
INSERT INTO `__new_local_hub_config`("id", "organization_id", "created_at_ms", "updated_at_ms", "store_id", "device_id", "singleton_guard", "setup_completed_at_ms", "negative_stock_policy", "cashier_discount_percent_unlimited", "cashier_max_discount_percent_bp", "cashier_discount_amount_unlimited", "cashier_max_discount_amount", "quick_sale_default_mxik", "quick_sale_default_vat_rate_bp", "store_timezone", "default_customer_due_days", "default_supplier_due_days", "max_cash_discrepancy_without_override", "printer_mode", "printer_name", "printer_host", "printer_port", "printer_timeout_ms", "printer_paper_width_mm", "printer_encoding", "printer_auto_print_sale", "printer_cash_drawer_auto_open", "receipt_header_title", "receipt_footer_text", "max_rule_package_version", "fiscal_mode_enabled", "fiscal_offline_window_ms", "fiscal_block_on_offline_expired", "fiscal_require_open_shift", "fiscal_receipt_fields_json", "fiscal_driver_id") SELECT "id", "organization_id", "created_at_ms", "updated_at_ms", "store_id", "device_id", "singleton_guard", "setup_completed_at_ms", "negative_stock_policy", "cashier_discount_percent_unlimited", "cashier_max_discount_percent_bp", "cashier_discount_amount_unlimited", "cashier_max_discount_amount", "quick_sale_default_mxik", "quick_sale_default_vat_rate_bp", "store_timezone", "default_customer_due_days", "default_supplier_due_days", "max_cash_discrepancy_without_override", "printer_mode", "printer_name", "printer_host", "printer_port", "printer_timeout_ms", "printer_paper_width_mm", "printer_encoding", "printer_auto_print_sale", "printer_cash_drawer_auto_open", "receipt_header_title", "receipt_footer_text", "max_rule_package_version", "fiscal_mode_enabled", 86400000, 0, 0, '[]', 'fake' FROM `local_hub_config`;--> statement-breakpoint
DROP TABLE `local_hub_config`;--> statement-breakpoint
ALTER TABLE `__new_local_hub_config` RENAME TO `local_hub_config`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `uidx_local_hub_config_singleton` ON `local_hub_config` (`singleton_guard`);--> statement-breakpoint
DROP TRIGGER IF EXISTS "trg_fiscal_docs_no_delete";
--> statement-breakpoint
CREATE TRIGGER "trg_fiscal_docs_no_delete"
BEFORE DELETE ON "fiscal_docs"
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'MONOTONE table "fiscal_docs" forbids physical DELETE: use tombstone');
END;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "trg_fiscal_docs_transition";
--> statement-breakpoint
DROP TRIGGER IF EXISTS "trg_fiscal_docs_terminal";
--> statement-breakpoint
DROP TRIGGER IF EXISTS "trg_fiscal_docs_immutable_core";
--> statement-breakpoint
CREATE TRIGGER "trg_fiscal_docs_transition"
BEFORE UPDATE ON "fiscal_docs"
FOR EACH ROW
WHEN NEW."status" IS NOT OLD."status" AND NOT (
  (OLD."status" = 'pending' AND NEW."status" = 'sent') OR
  (OLD."status" = 'pending' AND NEW."status" = 'cancelled') OR
  (OLD."status" = 'sent' AND NEW."status" = 'confirmed') OR
  (OLD."status" = 'sent' AND NEW."status" = 'rejected') OR
  (OLD."status" = 'sent' AND NEW."status" = 'failed') OR
  (OLD."status" = 'failed' AND NEW."status" = 'sent') OR
  (OLD."status" = 'failed' AND NEW."status" = 'cancelled') OR
  (OLD."status" = 'rejected' AND NEW."status" = 'cancelled')
)
BEGIN
  SELECT RAISE(ABORT, 'MONOTONE table "fiscal_docs" forbids this status transition');
END;
--> statement-breakpoint
CREATE TRIGGER "trg_fiscal_docs_terminal"
BEFORE UPDATE ON "fiscal_docs"
FOR EACH ROW
WHEN OLD."status" IN ('confirmed', 'cancelled') OR (OLD."status" = 'rejected' AND NEW."status" IS NOT 'cancelled')
BEGIN
  SELECT RAISE(ABORT, 'MONOTONE table "fiscal_docs" cannot be modified once confirmed, cancelled or rejected');
END;
--> statement-breakpoint
CREATE TRIGGER "trg_fiscal_docs_immutable_core"
BEFORE UPDATE ON "fiscal_docs"
FOR EACH ROW
WHEN
  NEW."id" IS NOT OLD."id" OR
  NEW."organization_id" IS NOT OLD."organization_id" OR
  NEW."store_id" IS NOT OLD."store_id" OR
  NEW."created_at_ms" IS NOT OLD."created_at_ms" OR
  NEW."doc_kind" IS NOT OLD."doc_kind" OR
  NEW."sale_id" IS NOT OLD."sale_id" OR
  NEW."return_id" IS NOT OLD."return_id" OR
  NEW."shift_id" IS NOT OLD."shift_id" OR
  NEW."depends_on_doc_id" IS NOT OLD."depends_on_doc_id" OR
  NEW."idempotency_key" IS NOT OLD."idempotency_key" OR
  NEW."driver_id" IS NOT OLD."driver_id" OR
  NEW."offline_deadline_ms" IS NOT OLD."offline_deadline_ms" OR
  NEW."attempts" < OLD."attempts"
BEGIN
  SELECT RAISE(ABORT, 'MONOTONE table "fiscal_docs" forbids mutating immutable fields');
END;
