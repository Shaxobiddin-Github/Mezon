CREATE TABLE `local_cloud_state` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at_ms` integer NOT NULL,
	`updated_at_ms` integer NOT NULL,
	`singleton_guard` integer DEFAULT 1 NOT NULL,
	`status` text DEFAULT 'unpaired' NOT NULL,
	`cloud_url` text,
	`cloud_organization_id` text,
	`cloud_organization_name` text,
	`cloud_store_id` text,
	`cloud_store_name` text,
	`encrypted_device_token` text,
	`paired_at_ms` integer,
	`last_sync_at_ms` integer,
	CONSTRAINT "chk_local_cloud_state_created_at_ms_int" CHECK(typeof("local_cloud_state"."created_at_ms") = 'integer'),
	CONSTRAINT "chk_local_cloud_state_updated_at_ms_int" CHECK(typeof("local_cloud_state"."updated_at_ms") = 'integer'),
	CONSTRAINT "chk_local_cloud_state_paired_at_ms_int" CHECK("local_cloud_state"."paired_at_ms" IS NULL OR typeof("local_cloud_state"."paired_at_ms") = 'integer'),
	CONSTRAINT "chk_local_cloud_state_last_sync_at_ms_int" CHECK("local_cloud_state"."last_sync_at_ms" IS NULL OR typeof("local_cloud_state"."last_sync_at_ms") = 'integer'),
	CONSTRAINT "chk_local_cloud_state_singleton" CHECK("local_cloud_state"."singleton_guard" = 1),
	CONSTRAINT "chk_local_cloud_state_status" CHECK("local_cloud_state"."status" IN ('unpaired', 'paired', 'revoked'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uidx_local_cloud_state_singleton` ON `local_cloud_state` (`singleton_guard`);