CREATE TABLE `local_sync_apply_state` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`created_at_ms` integer NOT NULL,
	`updated_at_ms` integer NOT NULL,
	`in_sync` integer DEFAULT 0 NOT NULL,
	CONSTRAINT "chk_local_sync_apply_state_created_at_ms_int" CHECK(typeof("local_sync_apply_state"."created_at_ms") = 'integer'),
	CONSTRAINT "chk_local_sync_apply_state_updated_at_ms_int" CHECK(typeof("local_sync_apply_state"."updated_at_ms") = 'integer'),
	CONSTRAINT "chk_local_sync_apply_state_in_sync" CHECK("local_sync_apply_state"."in_sync" IN (0, 1))
);
--> statement-breakpoint
CREATE TABLE `local_sync_cursors` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`created_at_ms` integer NOT NULL,
	`updated_at_ms` integer NOT NULL,
	`store_id` text NOT NULL,
	`last_position` integer DEFAULT 0 NOT NULL,
	CONSTRAINT "chk_local_sync_cursors_created_at_ms_int" CHECK(typeof("local_sync_cursors"."created_at_ms") = 'integer'),
	CONSTRAINT "chk_local_sync_cursors_updated_at_ms_int" CHECK(typeof("local_sync_cursors"."updated_at_ms") = 'integer'),
	CONSTRAINT "chk_local_sync_cursors_last_position_int" CHECK(typeof("local_sync_cursors"."last_position") = 'integer')
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uidx_local_sync_cursors_org_store` ON `local_sync_cursors` (`organization_id`,`store_id`);--> statement-breakpoint
CREATE TABLE `local_sync_parked` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`created_at_ms` integer NOT NULL,
	`updated_at_ms` integer NOT NULL,
	`store_id` text NOT NULL,
	`event_id` text NOT NULL,
	`entity` text NOT NULL,
	`entity_id` text NOT NULL,
	`missing_ref_entity` text NOT NULL,
	`missing_ref_id` text NOT NULL,
	`attempts` integer DEFAULT 1 NOT NULL,
	`payload` text NOT NULL,
	`last_error` text,
	CONSTRAINT "chk_local_sync_parked_created_at_ms_int" CHECK(typeof("local_sync_parked"."created_at_ms") = 'integer'),
	CONSTRAINT "chk_local_sync_parked_updated_at_ms_int" CHECK(typeof("local_sync_parked"."updated_at_ms") = 'integer')
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uidx_local_sync_parked_event` ON `local_sync_parked` (`organization_id`,`event_id`);--> statement-breakpoint
CREATE INDEX `idx_local_sync_parked_missing_ref` ON `local_sync_parked` (`organization_id`,`missing_ref_entity`,`missing_ref_id`);--> statement-breakpoint
INSERT OR IGNORE INTO `local_sync_apply_state` (`id`, `organization_id`, `created_at_ms`, `updated_at_ms`, `in_sync`) VALUES ('singleton', '00000000-0000-7000-8000-000000000000', 0, 0, 0);--> statement-breakpoint
DROP TRIGGER IF EXISTS "trg_sales_closed_shift_guard";--> statement-breakpoint
CREATE TRIGGER "trg_sales_closed_shift_guard"
BEFORE INSERT ON "sales"
FOR EACH ROW
WHEN COALESCE((SELECT in_sync FROM "local_sync_apply_state" WHERE "id" = 'singleton'), 0) = 0
  AND NEW."shift_id" IS NOT NULL AND EXISTS (
    SELECT 1 FROM "shifts" sh WHERE sh."id" = NEW."shift_id" AND sh."status" = 'closed'
  )
BEGIN
  SELECT RAISE(ABORT, 'Cannot insert into "sales" referencing an already closed shift');
END;--> statement-breakpoint
DROP TRIGGER IF EXISTS "trg_returns_closed_shift_guard";--> statement-breakpoint
CREATE TRIGGER "trg_returns_closed_shift_guard"
BEFORE INSERT ON "returns"
FOR EACH ROW
WHEN COALESCE((SELECT in_sync FROM "local_sync_apply_state" WHERE "id" = 'singleton'), 0) = 0
  AND NEW."shift_id" IS NOT NULL AND EXISTS (
    SELECT 1 FROM "shifts" sh WHERE sh."id" = NEW."shift_id" AND sh."status" = 'closed'
  )
BEGIN
  SELECT RAISE(ABORT, 'Cannot insert into "returns" referencing an already closed shift');
END;--> statement-breakpoint
DROP TRIGGER IF EXISTS "trg_cash_moves_closed_shift_guard";--> statement-breakpoint
CREATE TRIGGER "trg_cash_moves_closed_shift_guard"
BEFORE INSERT ON "cash_moves"
FOR EACH ROW
WHEN COALESCE((SELECT in_sync FROM "local_sync_apply_state" WHERE "id" = 'singleton'), 0) = 0
  AND NEW."shift_id" IS NOT NULL AND EXISTS (
    SELECT 1 FROM "shifts" sh WHERE sh."id" = NEW."shift_id" AND sh."status" = 'closed'
  )
BEGIN
  SELECT RAISE(ABORT, 'Cannot insert into "cash_moves" referencing an already closed shift');
END;
