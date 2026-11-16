CREATE TABLE `local_sync_conflicts` (
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
	CONSTRAINT "chk_local_sync_conflicts_created_at_ms_int" CHECK(typeof("local_sync_conflicts"."created_at_ms") = 'integer'),
	CONSTRAINT "chk_local_sync_conflicts_updated_at_ms_int" CHECK(typeof("local_sync_conflicts"."updated_at_ms") = 'integer'),
	CONSTRAINT "chk_local_sync_conflicts_resolved_at_ms_int" CHECK("local_sync_conflicts"."resolved_at_ms" IS NULL OR typeof("local_sync_conflicts"."resolved_at_ms") = 'integer')
);
--> statement-breakpoint
CREATE INDEX `idx_local_sync_conflicts_event` ON `local_sync_conflicts` (`event_id`);--> statement-breakpoint
CREATE INDEX `idx_local_sync_conflicts_created` ON `local_sync_conflicts` (`organization_id`,`created_at_ms`);