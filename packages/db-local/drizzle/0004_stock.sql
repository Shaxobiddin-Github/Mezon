CREATE TABLE `batches` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`store_id` text NOT NULL,
	`device_id` text NOT NULL,
	`hlc` text NOT NULL,
	`created_at_ms` integer NOT NULL,
	`product_id` text NOT NULL,
	`variant_id` text,
	`batch_number` text,
	`expiry_date_ms` integer,
	`initial_qty` integer NOT NULL,
	`initial_cost_value` integer NOT NULL,
	`supplier_id` text,
	FOREIGN KEY (`product_id`) REFERENCES `products`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`variant_id`) REFERENCES `product_variants`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "chk_batches_hlc_len" CHECK(length("batches"."hlc") = 58),
	CONSTRAINT "chk_batches_created_at_ms_int" CHECK(typeof("batches"."created_at_ms") = 'integer'),
	CONSTRAINT "chk_batches_expiry_date_ms_int" CHECK("batches"."expiry_date_ms" IS NULL OR typeof("batches"."expiry_date_ms") = 'integer'),
	CONSTRAINT "chk_batches_initial_qty_int" CHECK(typeof("batches"."initial_qty") = 'integer'),
	CONSTRAINT "chk_batches_initial_cost_value_int" CHECK(typeof("batches"."initial_cost_value") = 'integer'),
	CONSTRAINT "chk_batches_initial_qty_pos" CHECK("batches"."initial_qty" > 0),
	CONSTRAINT "chk_batches_initial_cost_nonneg" CHECK("batches"."initial_cost_value" >= 0)
);
--> statement-breakpoint
CREATE INDEX `idx_batches_store_prod_fifo` ON `batches` (`organization_id`,`store_id`,`product_id`,`variant_id`,`hlc`,`id`);--> statement-breakpoint
CREATE TABLE `inventory_count_lines` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`store_id` text NOT NULL,
	`device_id` text NOT NULL,
	`hlc` text NOT NULL,
	`created_at_ms` integer NOT NULL,
	`updated_at_ms` integer NOT NULL,
	`count_id` text NOT NULL,
	`product_id` text NOT NULL,
	`variant_id` text,
	`expected_qty_at_count` integer,
	`counted_qty` integer,
	`adjustment_qty` integer,
	FOREIGN KEY (`count_id`) REFERENCES `inventory_counts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`product_id`) REFERENCES `products`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`variant_id`) REFERENCES `product_variants`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "chk_inventory_count_lines_hlc_len" CHECK(length("inventory_count_lines"."hlc") = 58),
	CONSTRAINT "chk_inventory_count_lines_created_at_ms_int" CHECK(typeof("inventory_count_lines"."created_at_ms") = 'integer'),
	CONSTRAINT "chk_inventory_count_lines_updated_at_ms_int" CHECK(typeof("inventory_count_lines"."updated_at_ms") = 'integer'),
	CONSTRAINT "chk_inventory_count_lines_expected_qty_at_count_int" CHECK("inventory_count_lines"."expected_qty_at_count" IS NULL OR typeof("inventory_count_lines"."expected_qty_at_count") = 'integer'),
	CONSTRAINT "chk_inventory_count_lines_counted_qty_int" CHECK("inventory_count_lines"."counted_qty" IS NULL OR typeof("inventory_count_lines"."counted_qty") = 'integer'),
	CONSTRAINT "chk_inventory_count_lines_adjustment_qty_int" CHECK("inventory_count_lines"."adjustment_qty" IS NULL OR typeof("inventory_count_lines"."adjustment_qty") = 'integer'),
	CONSTRAINT "chk_inv_count_lines_counted_snapshot" CHECK("inventory_count_lines"."counted_qty" IS NULL OR ("inventory_count_lines"."counted_qty" >= 0 AND "inventory_count_lines"."expected_qty_at_count" IS NOT NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uidx_inv_count_lines_prod` ON `inventory_count_lines` (`count_id`,`product_id`) WHERE "inventory_count_lines"."variant_id" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `uidx_inv_count_lines_var` ON `inventory_count_lines` (`count_id`,`product_id`,`variant_id`) WHERE "inventory_count_lines"."variant_id" IS NOT NULL;--> statement-breakpoint
CREATE TABLE `inventory_counts` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`store_id` text NOT NULL,
	`device_id` text NOT NULL,
	`hlc` text NOT NULL,
	`created_at_ms` integer NOT NULL,
	`updated_at_ms` integer NOT NULL,
	`status` text DEFAULT 'open' NOT NULL,
	`started_by_user_id` text NOT NULL,
	`finalized_by_user_id` text,
	`finalized_at_ms` integer,
	`note` text,
	FOREIGN KEY (`started_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`finalized_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "chk_inventory_counts_hlc_len" CHECK(length("inventory_counts"."hlc") = 58),
	CONSTRAINT "chk_inventory_counts_created_at_ms_int" CHECK(typeof("inventory_counts"."created_at_ms") = 'integer'),
	CONSTRAINT "chk_inventory_counts_updated_at_ms_int" CHECK(typeof("inventory_counts"."updated_at_ms") = 'integer'),
	CONSTRAINT "chk_inventory_counts_finalized_at_ms_int" CHECK("inventory_counts"."finalized_at_ms" IS NULL OR typeof("inventory_counts"."finalized_at_ms") = 'integer'),
	CONSTRAINT "chk_inventory_counts_status" CHECK("inventory_counts"."status" IN ('open', 'finalized', 'cancelled')),
	CONSTRAINT "chk_inventory_counts_finalized_consistency" CHECK(("inventory_counts"."status" = 'open' AND "inventory_counts"."finalized_at_ms" IS NULL) OR ("inventory_counts"."status" <> 'open' AND "inventory_counts"."finalized_at_ms" IS NOT NULL))
);
--> statement-breakpoint
CREATE INDEX `idx_inventory_counts_store_status` ON `inventory_counts` (`organization_id`,`store_id`,`status`,`created_at_ms`);--> statement-breakpoint
CREATE TABLE `local_batch_balances` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`store_id` text NOT NULL,
	`created_at_ms` integer NOT NULL,
	`updated_at_ms` integer NOT NULL,
	`batch_id` text NOT NULL,
	`product_id` text NOT NULL,
	`variant_id` text,
	`hlc` text NOT NULL,
	`remaining_qty` integer NOT NULL,
	`remaining_value` integer NOT NULL,
	FOREIGN KEY (`batch_id`) REFERENCES `batches`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`product_id`) REFERENCES `products`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`variant_id`) REFERENCES `product_variants`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "chk_local_batch_balances_created_at_ms_int" CHECK(typeof("local_batch_balances"."created_at_ms") = 'integer'),
	CONSTRAINT "chk_local_batch_balances_updated_at_ms_int" CHECK(typeof("local_batch_balances"."updated_at_ms") = 'integer'),
	CONSTRAINT "chk_local_batch_balances_hlc_len" CHECK(length("local_batch_balances"."hlc") = 58),
	CONSTRAINT "chk_local_batch_balances_remaining_qty_int" CHECK(typeof("local_batch_balances"."remaining_qty") = 'integer'),
	CONSTRAINT "chk_local_batch_balances_remaining_value_int" CHECK(typeof("local_batch_balances"."remaining_value") = 'integer')
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uidx_local_batch_balances_batch` ON `local_batch_balances` (`batch_id`);--> statement-breakpoint
CREATE INDEX `idx_local_batch_balances_fifo` ON `local_batch_balances` (`organization_id`,`store_id`,`product_id`,`variant_id`,`hlc`,`batch_id`);--> statement-breakpoint
CREATE TABLE `local_stock_balances` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`store_id` text NOT NULL,
	`created_at_ms` integer NOT NULL,
	`updated_at_ms` integer NOT NULL,
	`product_id` text NOT NULL,
	`variant_id` text,
	`qty_on_hand` integer NOT NULL,
	`total_value` integer NOT NULL,
	`deficit_qty` integer NOT NULL,
	`provisional_deficit_value` integer NOT NULL,
	`cost_variance_value` integer NOT NULL,
	`last_unit_cost` integer,
	FOREIGN KEY (`product_id`) REFERENCES `products`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`variant_id`) REFERENCES `product_variants`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "chk_local_stock_balances_created_at_ms_int" CHECK(typeof("local_stock_balances"."created_at_ms") = 'integer'),
	CONSTRAINT "chk_local_stock_balances_updated_at_ms_int" CHECK(typeof("local_stock_balances"."updated_at_ms") = 'integer'),
	CONSTRAINT "chk_local_stock_balances_qty_on_hand_int" CHECK(typeof("local_stock_balances"."qty_on_hand") = 'integer'),
	CONSTRAINT "chk_local_stock_balances_total_value_int" CHECK(typeof("local_stock_balances"."total_value") = 'integer'),
	CONSTRAINT "chk_local_stock_balances_deficit_qty_int" CHECK(typeof("local_stock_balances"."deficit_qty") = 'integer'),
	CONSTRAINT "chk_local_stock_balances_provisional_deficit_value_int" CHECK(typeof("local_stock_balances"."provisional_deficit_value") = 'integer'),
	CONSTRAINT "chk_local_stock_balances_cost_variance_value_int" CHECK(typeof("local_stock_balances"."cost_variance_value") = 'integer'),
	CONSTRAINT "chk_local_stock_balances_last_unit_cost_int" CHECK("local_stock_balances"."last_unit_cost" IS NULL OR typeof("local_stock_balances"."last_unit_cost") = 'integer')
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uidx_local_stock_balances_prod` ON `local_stock_balances` (`organization_id`,`store_id`,`product_id`) WHERE "local_stock_balances"."variant_id" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `uidx_local_stock_balances_var` ON `local_stock_balances` (`organization_id`,`store_id`,`product_id`,`variant_id`) WHERE "local_stock_balances"."variant_id" IS NOT NULL;--> statement-breakpoint
CREATE TABLE `local_stock_conflicts` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`store_id` text NOT NULL,
	`created_at_ms` integer NOT NULL,
	`updated_at_ms` integer NOT NULL,
	`product_id` text NOT NULL,
	`variant_id` text,
	`batch_id` text,
	`move_id` text,
	`conflict_qty` integer NOT NULL,
	`reason` text NOT NULL,
	`detail` text,
	`resolved_at_ms` integer,
	FOREIGN KEY (`product_id`) REFERENCES `products`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`variant_id`) REFERENCES `product_variants`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "chk_local_stock_conflicts_created_at_ms_int" CHECK(typeof("local_stock_conflicts"."created_at_ms") = 'integer'),
	CONSTRAINT "chk_local_stock_conflicts_updated_at_ms_int" CHECK(typeof("local_stock_conflicts"."updated_at_ms") = 'integer'),
	CONSTRAINT "chk_local_stock_conflicts_conflict_qty_int" CHECK(typeof("local_stock_conflicts"."conflict_qty") = 'integer'),
	CONSTRAINT "chk_local_stock_conflicts_resolved_at_ms_int" CHECK("local_stock_conflicts"."resolved_at_ms" IS NULL OR typeof("local_stock_conflicts"."resolved_at_ms") = 'integer'),
	CONSTRAINT "chk_local_stock_conflicts_reason" CHECK("local_stock_conflicts"."reason" IN ('BATCH_OVERCONSUMED', 'UNKNOWN_COST_SURPLUS', 'ORPHAN_BATCH_REFERENCE'))
);
--> statement-breakpoint
CREATE INDEX `idx_local_stock_conflicts_store_open` ON `local_stock_conflicts` (`organization_id`,`store_id`,`resolved_at_ms`,`created_at_ms`);--> statement-breakpoint
CREATE TABLE `stock_moves` (
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
	CONSTRAINT "chk_stock_moves_hlc_len" CHECK(length("stock_moves"."hlc") = 58),
	CONSTRAINT "chk_stock_moves_created_at_ms_int" CHECK(typeof("stock_moves"."created_at_ms") = 'integer'),
	CONSTRAINT "chk_stock_moves_qty_delta_int" CHECK(typeof("stock_moves"."qty_delta") = 'integer'),
	CONSTRAINT "chk_stock_moves_cost_value_delta_int" CHECK(typeof("stock_moves"."cost_value_delta") = 'integer'),
	CONSTRAINT "chk_stock_moves_qty_nonzero" CHECK("stock_moves"."qty_delta" <> 0),
	CONSTRAINT "chk_stock_moves_sign_match" CHECK(("stock_moves"."qty_delta" > 0 AND "stock_moves"."cost_value_delta" >= 0) OR ("stock_moves"."qty_delta" < 0 AND "stock_moves"."cost_value_delta" <= 0)),
	CONSTRAINT "chk_stock_moves_reason" CHECK("stock_moves"."reason" IN ('initial', 'purchase', 'sale', 'return', 'inventory', 'adjustment', 'damaged', 'broken', 'personal', 'lost')),
	CONSTRAINT "chk_stock_moves_source_type" CHECK("stock_moves"."source_type" IN ('stock_entry', 'inventory_count', 'sale', 'return', 'purchase', 'adjustment'))
);
--> statement-breakpoint
CREATE INDEX `idx_stock_moves_store_prod_hlc` ON `stock_moves` (`organization_id`,`store_id`,`product_id`,`variant_id`,`hlc`,`id`);--> statement-breakpoint
CREATE INDEX `idx_stock_moves_store_batch` ON `stock_moves` (`organization_id`,`store_id`,`batch_id`,`hlc`,`id`);--> statement-breakpoint
CREATE INDEX `idx_stock_moves_store_source` ON `stock_moves` (`organization_id`,`store_id`,`source_type`,`source_id`);--> statement-breakpoint
ALTER TABLE `local_hub_config` ADD `negative_stock_policy` text DEFAULT 'warn' NOT NULL CONSTRAINT "chk_local_hub_config_neg_policy" CHECK("negative_stock_policy" IN ('warn', 'block'));--> statement-breakpoint
ALTER TABLE `products` ADD `track_batches` integer DEFAULT false NOT NULL CONSTRAINT "chk_products_track_batches" CHECK("track_batches" IN (0, 1));--> statement-breakpoint
DROP TRIGGER IF EXISTS "trg_batches_no_update";--> statement-breakpoint
CREATE TRIGGER "trg_batches_no_update"
BEFORE UPDATE ON "batches"
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'FACT table "batches" is immutable: UPDATE is forbidden');
END;--> statement-breakpoint
DROP TRIGGER IF EXISTS "trg_batches_no_delete";--> statement-breakpoint
CREATE TRIGGER "trg_batches_no_delete"
BEFORE DELETE ON "batches"
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'FACT table "batches" forbids physical DELETE: use tombstone');
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
DROP TRIGGER IF EXISTS "trg_inventory_counts_no_delete";--> statement-breakpoint
CREATE TRIGGER "trg_inventory_counts_no_delete"
BEFORE DELETE ON "inventory_counts"
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'MONOTONE table "inventory_counts" forbids physical DELETE: use tombstone');
END;--> statement-breakpoint
DROP TRIGGER IF EXISTS "trg_inventory_count_lines_no_delete";--> statement-breakpoint
CREATE TRIGGER "trg_inventory_count_lines_no_delete"
BEFORE DELETE ON "inventory_count_lines"
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'MONOTONE table "inventory_count_lines" forbids physical DELETE: use tombstone');
END;--> statement-breakpoint
DROP TRIGGER IF EXISTS "trg_inventory_counts_monotone";--> statement-breakpoint
DROP TRIGGER IF EXISTS "trg_inventory_count_lines_parent_open_insert";--> statement-breakpoint
DROP TRIGGER IF EXISTS "trg_inventory_count_lines_parent_open_update";--> statement-breakpoint
CREATE TRIGGER "trg_inventory_counts_monotone"
BEFORE UPDATE ON "inventory_counts"
FOR EACH ROW
WHEN OLD."status" <> 'open'
BEGIN
  SELECT RAISE(ABORT, 'MONOTONE table "inventory_counts" cannot be modified after finalize/cancel');
END;--> statement-breakpoint
CREATE TRIGGER "trg_inventory_count_lines_parent_open_insert"
BEFORE INSERT ON "inventory_count_lines"
FOR EACH ROW
WHEN EXISTS (
  SELECT 1 FROM "inventory_counts" c
  WHERE c."id" = NEW."count_id" AND c."status" <> 'open'
)
BEGIN
  SELECT RAISE(ABORT, 'Cannot insert inventory_count_lines into non-open inventory_count');
END;--> statement-breakpoint
CREATE TRIGGER "trg_inventory_count_lines_parent_open_update"
BEFORE UPDATE ON "inventory_count_lines"
FOR EACH ROW
WHEN EXISTS (
  SELECT 1 FROM "inventory_counts" c
  WHERE c."id" = OLD."count_id" AND c."status" <> 'open'
) OR NEW."count_id" <> OLD."count_id"
BEGIN
  SELECT RAISE(ABORT, 'Cannot modify inventory_count_lines of finalized or cancelled inventory_count');
END;
