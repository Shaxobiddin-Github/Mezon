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
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uidx_customer_ledger_opening_balance` ON `customer_ledger` (`organization_id`,`customer_id`) WHERE "customer_ledger"."entry_type" = 'opening_balance';--> statement-breakpoint
CREATE UNIQUE INDEX `uidx_customer_ledger_org_client_req` ON `customer_ledger` (`organization_id`,`client_request_id`) WHERE "customer_ledger"."client_request_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX `idx_customer_ledger_cust_hlc` ON `customer_ledger` (`organization_id`,`customer_id`,`hlc`,`id`);--> statement-breakpoint
CREATE INDEX `idx_customer_ledger_cust_created` ON `customer_ledger` (`organization_id`,`customer_id`,`created_at_ms`,`id`);--> statement-breakpoint
CREATE INDEX `idx_customer_ledger_sale` ON `customer_ledger` (`sale_id`) WHERE "customer_ledger"."sale_id" IS NOT NULL;--> statement-breakpoint
CREATE TABLE `customers` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`device_id` text NOT NULL,
	`hlc` text NOT NULL,
	`created_at_ms` integer NOT NULL,
	`updated_at_ms` integer NOT NULL,
	`deleted_at_ms` integer,
	`full_name` text NOT NULL,
	`name_search` text NOT NULL,
	`phone_normalized` text,
	`phone_digits` text,
	`credit_limit` integer,
	`default_due_days` integer,
	`note` text,
	`is_active` integer DEFAULT true NOT NULL,
	CONSTRAINT "chk_customers_hlc_len" CHECK(length("customers"."hlc") = 58),
	CONSTRAINT "chk_customers_created_at_ms_int" CHECK(typeof("customers"."created_at_ms") = 'integer'),
	CONSTRAINT "chk_customers_updated_at_ms_int" CHECK(typeof("customers"."updated_at_ms") = 'integer'),
	CONSTRAINT "chk_customers_deleted_at_ms_int" CHECK("customers"."deleted_at_ms" IS NULL OR typeof("customers"."deleted_at_ms") = 'integer'),
	CONSTRAINT "chk_customers_credit_limit_int" CHECK("customers"."credit_limit" IS NULL OR typeof("customers"."credit_limit") = 'integer'),
	CONSTRAINT "chk_customers_name_nonempty" CHECK(length(trim("customers"."full_name")) >= 1),
	CONSTRAINT "chk_customers_phone_e164" CHECK("customers"."phone_normalized" IS NULL OR ("customers"."phone_normalized" GLOB '+[1-9]*' AND length("customers"."phone_normalized") BETWEEN 9 AND 16)),
	CONSTRAINT "chk_customers_phone_pair" CHECK(("customers"."phone_normalized" IS NULL AND "customers"."phone_digits" IS NULL) OR ("customers"."phone_normalized" IS NOT NULL AND "customers"."phone_digits" IS NOT NULL AND "customers"."phone_normalized" = ('+' || "customers"."phone_digits"))),
	CONSTRAINT "chk_customers_credit_nonneg" CHECK("customers"."credit_limit" IS NULL OR "customers"."credit_limit" >= 0),
	CONSTRAINT "chk_customers_due_days" CHECK("customers"."default_due_days" IS NULL OR ("customers"."default_due_days" >= 1 AND "customers"."default_due_days" <= 3650)),
	CONSTRAINT "chk_customers_is_active" CHECK("customers"."is_active" IN (0, 1))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uidx_customers_org_phone_active` ON `customers` (`organization_id`,`phone_normalized`) WHERE "customers"."deleted_at_ms" IS NULL AND "customers"."phone_normalized" IS NOT NULL;--> statement-breakpoint
CREATE INDEX `idx_customers_org_active_name` ON `customers` (`organization_id`,`deleted_at_ms`,`is_active`,`name_search`,`id`);--> statement-breakpoint
CREATE INDEX `idx_customers_org_phone_digits` ON `customers` (`organization_id`,`phone_digits`) WHERE "customers"."deleted_at_ms" IS NULL AND "customers"."phone_digits" IS NOT NULL;--> statement-breakpoint
CREATE TABLE `local_customer_balances` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`created_at_ms` integer NOT NULL,
	`updated_at_ms` integer NOT NULL,
	`customer_id` text NOT NULL,
	`balance` integer NOT NULL,
	`total_debt_accrued` integer NOT NULL,
	`total_settled` integer NOT NULL,
	`earliest_open_due_at_ms` integer,
	`last_activity_at_ms` integer,
	FOREIGN KEY (`customer_id`) REFERENCES `customers`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "chk_local_customer_balances_created_at_ms_int" CHECK(typeof("local_customer_balances"."created_at_ms") = 'integer'),
	CONSTRAINT "chk_local_customer_balances_updated_at_ms_int" CHECK(typeof("local_customer_balances"."updated_at_ms") = 'integer'),
	CONSTRAINT "chk_local_customer_balances_balance_int" CHECK(typeof("local_customer_balances"."balance") = 'integer'),
	CONSTRAINT "chk_local_customer_balances_total_debt_accrued_int" CHECK(typeof("local_customer_balances"."total_debt_accrued") = 'integer'),
	CONSTRAINT "chk_local_customer_balances_total_settled_int" CHECK(typeof("local_customer_balances"."total_settled") = 'integer'),
	CONSTRAINT "chk_local_customer_balances_earliest_open_due_at_ms_int" CHECK("local_customer_balances"."earliest_open_due_at_ms" IS NULL OR typeof("local_customer_balances"."earliest_open_due_at_ms") = 'integer'),
	CONSTRAINT "chk_local_customer_balances_last_activity_at_ms_int" CHECK("local_customer_balances"."last_activity_at_ms" IS NULL OR typeof("local_customer_balances"."last_activity_at_ms") = 'integer'),
	CONSTRAINT "chk_local_customer_balances_nonneg" CHECK("local_customer_balances"."balance" >= 0),
	CONSTRAINT "chk_local_customer_balances_accrued_nonneg" CHECK("local_customer_balances"."total_debt_accrued" >= 0),
	CONSTRAINT "chk_local_customer_balances_settled_nonneg" CHECK("local_customer_balances"."total_settled" >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uidx_local_customer_balances_cust` ON `local_customer_balances` (`customer_id`);--> statement-breakpoint
CREATE INDEX `idx_local_customer_balances_org_due` ON `local_customer_balances` (`organization_id`,`balance`,`earliest_open_due_at_ms`,`customer_id`);--> statement-breakpoint
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
	CONSTRAINT "chk_local_hub_config_cust_due_days" CHECK("__new_local_hub_config"."default_customer_due_days" IS NULL OR ("__new_local_hub_config"."default_customer_due_days" >= 1 AND "__new_local_hub_config"."default_customer_due_days" <= 3650))
);
--> statement-breakpoint
INSERT INTO `__new_local_hub_config`("id", "organization_id", "created_at_ms", "updated_at_ms", "store_id", "device_id", "singleton_guard", "setup_completed_at_ms", "negative_stock_policy", "cashier_discount_percent_unlimited", "cashier_max_discount_percent_bp", "cashier_discount_amount_unlimited", "cashier_max_discount_amount", "quick_sale_default_mxik", "quick_sale_default_vat_rate_bp", "store_timezone", "default_customer_due_days") SELECT "id", "organization_id", "created_at_ms", "updated_at_ms", "store_id", "device_id", "singleton_guard", "setup_completed_at_ms", "negative_stock_policy", "cashier_discount_percent_unlimited", "cashier_max_discount_percent_bp", "cashier_discount_amount_unlimited", "cashier_max_discount_amount", "quick_sale_default_mxik", "quick_sale_default_vat_rate_bp", "store_timezone", 14 FROM `local_hub_config`;--> statement-breakpoint
DROP TABLE `local_hub_config`;--> statement-breakpoint
ALTER TABLE `__new_local_hub_config` RENAME TO `local_hub_config`;--> statement-breakpoint
CREATE UNIQUE INDEX `uidx_local_hub_config_singleton` ON `local_hub_config` (`singleton_guard`);--> statement-breakpoint
DROP TRIGGER IF EXISTS "trg_customers_no_delete";--> statement-breakpoint
CREATE TRIGGER "trg_customers_no_delete"
BEFORE DELETE ON "customers"
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'ATTR table "customers" forbids physical DELETE: use tombstone');
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
DROP TRIGGER IF EXISTS "trg_customers_fts_after_insert";--> statement-breakpoint
DROP TRIGGER IF EXISTS "trg_customers_fts_after_update";--> statement-breakpoint
DROP TABLE IF EXISTS "customers_fts";--> statement-breakpoint
CREATE VIRTUAL TABLE "customers_fts" USING fts5(
  customer_id UNINDEXED,
  organization_id UNINDEXED,
  name_search,
  phone_digits,
  tokenize = 'unicode61 remove_diacritics 0',
  prefix = '2 3'
);--> statement-breakpoint
CREATE TRIGGER "trg_customers_fts_after_insert"
AFTER INSERT ON "customers"
FOR EACH ROW
WHEN NEW."deleted_at_ms" IS NULL
BEGIN
  INSERT INTO "customers_fts" ("customer_id", "organization_id", "name_search", "phone_digits")
  VALUES (NEW."id", NEW."organization_id", NEW."name_search", COALESCE(NEW."phone_digits", ''));
END;--> statement-breakpoint
CREATE TRIGGER "trg_customers_fts_after_update"
AFTER UPDATE ON "customers"
FOR EACH ROW
BEGIN
  DELETE FROM "customers_fts" WHERE "customer_id" = OLD."id";
  INSERT INTO "customers_fts" ("customer_id", "organization_id", "name_search", "phone_digits")
  SELECT NEW."id", NEW."organization_id", NEW."name_search", COALESCE(NEW."phone_digits", '')
  WHERE NEW."deleted_at_ms" IS NULL;
END;