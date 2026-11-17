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
CREATE INDEX `idx_local_customer_balances_org_due` ON `local_customer_balances` (`organization_id`,`balance`,`earliest_open_due_at_ms`,`customer_id`);--> statement-breakpoint
CREATE TABLE `__new_local_sync_conflicts` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`created_at_ms` integer NOT NULL,
	`updated_at_ms` integer NOT NULL,
	`store_id` text,
	`event_id` text NOT NULL,
	`entity` text NOT NULL,
	`entity_id` text NOT NULL,
	`reason` text NOT NULL,
	`error` text,
	`payload` text NOT NULL,
	`resolved_at_ms` integer,
	`event_json` text,
	`resolution` text,
	`resolved_by_user_id` text,
	`resolution_note` text,
	CONSTRAINT "chk_local_sync_conflicts_created_at_ms_int" CHECK(typeof("__new_local_sync_conflicts"."created_at_ms") = 'integer'),
	CONSTRAINT "chk_local_sync_conflicts_updated_at_ms_int" CHECK(typeof("__new_local_sync_conflicts"."updated_at_ms") = 'integer'),
	CONSTRAINT "chk_local_sync_conflicts_resolved_at_ms_int" CHECK("__new_local_sync_conflicts"."resolved_at_ms" IS NULL OR typeof("__new_local_sync_conflicts"."resolved_at_ms") = 'integer'),
	CONSTRAINT "chk_local_sync_conflicts_resolution" CHECK("__new_local_sync_conflicts"."resolution" IS NULL OR "__new_local_sync_conflicts"."resolution" IN ('retried', 'acknowledged', 'auto')),
	CONSTRAINT "chk_local_sync_conflicts_resolved_pair" CHECK(("__new_local_sync_conflicts"."resolved_at_ms" IS NULL) = ("__new_local_sync_conflicts"."resolution" IS NULL)),
	CONSTRAINT "chk_local_sync_conflicts_note_len" CHECK("__new_local_sync_conflicts"."resolution_note" IS NULL OR length("__new_local_sync_conflicts"."resolution_note") <= 500)
);
--> statement-breakpoint
INSERT INTO `__new_local_sync_conflicts`("id", "organization_id", "created_at_ms", "updated_at_ms", "store_id", "event_id", "entity", "entity_id", "reason", "error", "payload", "resolved_at_ms", "event_json", "resolution", "resolved_by_user_id", "resolution_note") SELECT "id", "organization_id", "created_at_ms", "updated_at_ms", "store_id", "event_id", "entity", "entity_id", "reason", "error", "payload", "resolved_at_ms", NULL, CASE WHEN "resolved_at_ms" IS NOT NULL THEN 'auto' END, NULL, NULL FROM `local_sync_conflicts`;--> statement-breakpoint
DROP TABLE `local_sync_conflicts`;--> statement-breakpoint
ALTER TABLE `__new_local_sync_conflicts` RENAME TO `local_sync_conflicts`;--> statement-breakpoint
CREATE INDEX `idx_local_sync_conflicts_event` ON `local_sync_conflicts` (`event_id`);--> statement-breakpoint
CREATE INDEX `idx_local_sync_conflicts_created` ON `local_sync_conflicts` (`organization_id`,`created_at_ms`);--> statement-breakpoint
CREATE INDEX `idx_local_sync_conflicts_open` ON `local_sync_conflicts` (`organization_id`,`reason`,`entity`,`entity_id`,`resolved_at_ms`);