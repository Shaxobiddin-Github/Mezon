CREATE TABLE `local_device_state` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`created_at_ms` integer NOT NULL,
	`updated_at_ms` integer NOT NULL,
	`device_id` text NOT NULL,
	`last_device_seq` integer NOT NULL,
	`last_hlc` text NOT NULL,
	`last_uuid_ms` integer NOT NULL,
	CONSTRAINT "chk_local_device_state_created_at_ms_int" CHECK(typeof("local_device_state"."created_at_ms") = 'integer'),
	CONSTRAINT "chk_local_device_state_updated_at_ms_int" CHECK(typeof("local_device_state"."updated_at_ms") = 'integer'),
	CONSTRAINT "chk_local_device_state_last_device_seq_int" CHECK(typeof("local_device_state"."last_device_seq") = 'integer'),
	CONSTRAINT "chk_local_device_state_last_hlc_len" CHECK(length("local_device_state"."last_hlc") = 58),
	CONSTRAINT "chk_local_device_state_last_uuid_ms_int" CHECK(typeof("local_device_state"."last_uuid_ms") = 'integer'),
	CONSTRAINT "chk_local_device_state_seq_nonneg" CHECK("local_device_state"."last_device_seq" >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uidx_local_device_state_device_id` ON `local_device_state` (`device_id`);--> statement-breakpoint
CREATE TABLE `local_outbox` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`created_at_ms` integer NOT NULL,
	`updated_at_ms` integer NOT NULL,
	`store_id` text,
	`device_id` text NOT NULL,
	`device_seq` integer NOT NULL,
	`hlc` text NOT NULL,
	`type` text NOT NULL,
	`entity` text NOT NULL,
	`entity_id` text NOT NULL,
	`class` text NOT NULL,
	`schema_version` integer NOT NULL,
	`payload` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`last_error` text,
	`pushed_at_ms` integer,
	CONSTRAINT "chk_local_outbox_created_at_ms_int" CHECK(typeof("local_outbox"."created_at_ms") = 'integer'),
	CONSTRAINT "chk_local_outbox_updated_at_ms_int" CHECK(typeof("local_outbox"."updated_at_ms") = 'integer'),
	CONSTRAINT "chk_local_outbox_device_seq_int" CHECK(typeof("local_outbox"."device_seq") = 'integer'),
	CONSTRAINT "chk_local_outbox_hlc_len" CHECK(length("local_outbox"."hlc") = 58),
	CONSTRAINT "chk_local_outbox_pushed_at_ms_int" CHECK("local_outbox"."pushed_at_ms" IS NULL OR typeof("local_outbox"."pushed_at_ms") = 'integer'),
	CONSTRAINT "chk_local_outbox_device_seq_pos" CHECK("local_outbox"."device_seq" >= 1),
	CONSTRAINT "chk_local_outbox_class" CHECK("local_outbox"."class" IN ('FACT', 'ATTR', 'MONOTONE')),
	CONSTRAINT "chk_local_outbox_schema_ver" CHECK("local_outbox"."schema_version" >= 1),
	CONSTRAINT "chk_local_outbox_status" CHECK("local_outbox"."status" IN ('pending', 'acked', 'rejected')),
	CONSTRAINT "chk_local_outbox_attempts" CHECK("local_outbox"."attempts" >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uidx_local_outbox_device_seq` ON `local_outbox` (`device_id`,`device_seq`);--> statement-breakpoint
CREATE INDEX `idx_local_outbox_status_seq` ON `local_outbox` (`status`,`device_seq`);