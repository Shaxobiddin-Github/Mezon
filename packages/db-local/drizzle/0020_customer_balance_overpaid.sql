PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_local_customer_balances` (
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
	CONSTRAINT "chk_local_customer_balances_created_at_ms_int" CHECK(typeof("__new_local_customer_balances"."created_at_ms") = 'integer'),
	CONSTRAINT "chk_local_customer_balances_updated_at_ms_int" CHECK(typeof("__new_local_customer_balances"."updated_at_ms") = 'integer'),
	CONSTRAINT "chk_local_customer_balances_balance_int" CHECK(typeof("__new_local_customer_balances"."balance") = 'integer'),
	CONSTRAINT "chk_local_customer_balances_total_debt_accrued_int" CHECK(typeof("__new_local_customer_balances"."total_debt_accrued") = 'integer'),
	CONSTRAINT "chk_local_customer_balances_total_settled_int" CHECK(typeof("__new_local_customer_balances"."total_settled") = 'integer'),
	CONSTRAINT "chk_local_customer_balances_earliest_open_due_at_ms_int" CHECK("__new_local_customer_balances"."earliest_open_due_at_ms" IS NULL OR typeof("__new_local_customer_balances"."earliest_open_due_at_ms") = 'integer'),
	CONSTRAINT "chk_local_customer_balances_last_activity_at_ms_int" CHECK("__new_local_customer_balances"."last_activity_at_ms" IS NULL OR typeof("__new_local_customer_balances"."last_activity_at_ms") = 'integer'),
	CONSTRAINT "chk_local_customer_balances_accrued_nonneg" CHECK("__new_local_customer_balances"."total_debt_accrued" >= 0),
	CONSTRAINT "chk_local_customer_balances_settled_nonneg" CHECK("__new_local_customer_balances"."total_settled" >= 0)
);
--> statement-breakpoint
INSERT INTO `__new_local_customer_balances`("id", "organization_id", "created_at_ms", "updated_at_ms", "customer_id", "balance", "total_debt_accrued", "total_settled", "earliest_open_due_at_ms", "last_activity_at_ms") SELECT "id", "organization_id", "created_at_ms", "updated_at_ms", "customer_id", "balance", "total_debt_accrued", "total_settled", "earliest_open_due_at_ms", "last_activity_at_ms" FROM `local_customer_balances`;--> statement-breakpoint
DROP TABLE `local_customer_balances`;--> statement-breakpoint
ALTER TABLE `__new_local_customer_balances` RENAME TO `local_customer_balances`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `uidx_local_customer_balances_cust` ON `local_customer_balances` (`customer_id`);--> statement-breakpoint
CREATE INDEX `idx_local_customer_balances_org_due` ON `local_customer_balances` (`organization_id`,`balance`,`earliest_open_due_at_ms`,`customer_id`);