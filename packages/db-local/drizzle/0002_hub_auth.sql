CREATE TABLE `local_device_auth_state` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`created_at_ms` integer NOT NULL,
	`updated_at_ms` integer NOT NULL,
	`device_id` text NOT NULL,
	`window_started_at_ms` integer NOT NULL,
	`failed_attempts` integer DEFAULT 0 NOT NULL,
	`next_allowed_at_ms` integer,
	`last_failed_at_ms` integer,
	CONSTRAINT "chk_local_device_auth_state_created_at_ms_int" CHECK(typeof("local_device_auth_state"."created_at_ms") = 'integer'),
	CONSTRAINT "chk_local_device_auth_state_updated_at_ms_int" CHECK(typeof("local_device_auth_state"."updated_at_ms") = 'integer'),
	CONSTRAINT "chk_local_device_auth_state_window_started_at_ms_int" CHECK(typeof("local_device_auth_state"."window_started_at_ms") = 'integer'),
	CONSTRAINT "chk_local_device_auth_state_next_allowed_at_ms_int" CHECK("local_device_auth_state"."next_allowed_at_ms" IS NULL OR typeof("local_device_auth_state"."next_allowed_at_ms") = 'integer'),
	CONSTRAINT "chk_local_device_auth_state_last_failed_at_ms_int" CHECK("local_device_auth_state"."last_failed_at_ms" IS NULL OR typeof("local_device_auth_state"."last_failed_at_ms") = 'integer'),
	CONSTRAINT "chk_local_device_auth_state_failed_nonneg" CHECK("local_device_auth_state"."failed_attempts" >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uidx_local_device_auth_state_device_id` ON `local_device_auth_state` (`device_id`);--> statement-breakpoint
CREATE TABLE `local_hub_config` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`created_at_ms` integer NOT NULL,
	`updated_at_ms` integer NOT NULL,
	`store_id` text NOT NULL,
	`device_id` text NOT NULL,
	`singleton_guard` integer NOT NULL,
	`setup_completed_at_ms` integer NOT NULL,
	CONSTRAINT "chk_local_hub_config_created_at_ms_int" CHECK(typeof("local_hub_config"."created_at_ms") = 'integer'),
	CONSTRAINT "chk_local_hub_config_updated_at_ms_int" CHECK(typeof("local_hub_config"."updated_at_ms") = 'integer'),
	CONSTRAINT "chk_local_hub_config_setup_completed_at_ms_int" CHECK(typeof("local_hub_config"."setup_completed_at_ms") = 'integer'),
	CONSTRAINT "chk_local_hub_config_singleton" CHECK("local_hub_config"."singleton_guard" = 1)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uidx_local_hub_config_singleton` ON `local_hub_config` (`singleton_guard`);--> statement-breakpoint
CREATE TABLE `local_pin_credentials` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`created_at_ms` integer NOT NULL,
	`updated_at_ms` integer NOT NULL,
	`user_id` text NOT NULL,
	`pin_hash` text NOT NULL,
	`pin_updated_at_ms` integer NOT NULL,
	`failed_attempts` integer DEFAULT 0 NOT NULL,
	`locked_until_ms` integer,
	`last_failed_at_ms` integer,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "chk_local_pin_credentials_created_at_ms_int" CHECK(typeof("local_pin_credentials"."created_at_ms") = 'integer'),
	CONSTRAINT "chk_local_pin_credentials_updated_at_ms_int" CHECK(typeof("local_pin_credentials"."updated_at_ms") = 'integer'),
	CONSTRAINT "chk_local_pin_credentials_pin_updated_at_ms_int" CHECK(typeof("local_pin_credentials"."pin_updated_at_ms") = 'integer'),
	CONSTRAINT "chk_local_pin_credentials_locked_until_ms_int" CHECK("local_pin_credentials"."locked_until_ms" IS NULL OR typeof("local_pin_credentials"."locked_until_ms") = 'integer'),
	CONSTRAINT "chk_local_pin_credentials_last_failed_at_ms_int" CHECK("local_pin_credentials"."last_failed_at_ms" IS NULL OR typeof("local_pin_credentials"."last_failed_at_ms") = 'integer'),
	CONSTRAINT "chk_local_pin_credentials_failed_nonneg" CHECK("local_pin_credentials"."failed_attempts" >= 0),
	CONSTRAINT "chk_local_pin_credentials_hash_nonempty" CHECK(length("local_pin_credentials"."pin_hash") >= 1)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uidx_local_pin_credentials_user_id` ON `local_pin_credentials` (`user_id`);--> statement-breakpoint
CREATE TABLE `local_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`created_at_ms` integer NOT NULL,
	`updated_at_ms` integer NOT NULL,
	`user_id` text NOT NULL,
	`device_id` text NOT NULL,
	`token_hash` text NOT NULL,
	`expires_at_ms` integer NOT NULL,
	`revoked_at_ms` integer,
	`last_seen_at_ms` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "chk_local_sessions_created_at_ms_int" CHECK(typeof("local_sessions"."created_at_ms") = 'integer'),
	CONSTRAINT "chk_local_sessions_updated_at_ms_int" CHECK(typeof("local_sessions"."updated_at_ms") = 'integer'),
	CONSTRAINT "chk_local_sessions_expires_at_ms_int" CHECK(typeof("local_sessions"."expires_at_ms") = 'integer'),
	CONSTRAINT "chk_local_sessions_revoked_at_ms_int" CHECK("local_sessions"."revoked_at_ms" IS NULL OR typeof("local_sessions"."revoked_at_ms") = 'integer'),
	CONSTRAINT "chk_local_sessions_last_seen_at_ms_int" CHECK(typeof("local_sessions"."last_seen_at_ms") = 'integer'),
	CONSTRAINT "chk_local_sessions_token_hash_len" CHECK(length("local_sessions"."token_hash") = 64)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uidx_local_sessions_token_hash` ON `local_sessions` (`token_hash`);--> statement-breakpoint
CREATE INDEX `idx_local_sessions_user_revoked` ON `local_sessions` (`user_id`,`revoked_at_ms`);--> statement-breakpoint
CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`device_id` text NOT NULL,
	`hlc` text NOT NULL,
	`created_at_ms` integer NOT NULL,
	`updated_at_ms` integer NOT NULL,
	`deleted_at_ms` integer,
	`username` text NOT NULL,
	`full_name` text NOT NULL,
	`role` text NOT NULL,
	`is_active` integer NOT NULL,
	CONSTRAINT "chk_users_hlc_len" CHECK(length("users"."hlc") = 58),
	CONSTRAINT "chk_users_created_at_ms_int" CHECK(typeof("users"."created_at_ms") = 'integer'),
	CONSTRAINT "chk_users_updated_at_ms_int" CHECK(typeof("users"."updated_at_ms") = 'integer'),
	CONSTRAINT "chk_users_deleted_at_ms_int" CHECK("users"."deleted_at_ms" IS NULL OR typeof("users"."deleted_at_ms") = 'integer'),
	CONSTRAINT "chk_users_role" CHECK("users"."role" IN ('owner', 'manager', 'cashier')),
	CONSTRAINT "chk_users_is_active" CHECK("users"."is_active" IN (0, 1)),
	CONSTRAINT "chk_users_username_nonempty" CHECK(length(trim("users"."username")) >= 2),
	CONSTRAINT "chk_users_full_name_nonempty" CHECK(length(trim("users"."full_name")) >= 1)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uidx_users_org_username` ON `users` (`organization_id`,`username`) WHERE "users"."deleted_at_ms" IS NULL;--> statement-breakpoint
CREATE INDEX `idx_users_org_active_role` ON `users` (`organization_id`,`deleted_at_ms`,`is_active`);--> statement-breakpoint
DROP TRIGGER IF EXISTS "trg_users_no_delete";--> statement-breakpoint
CREATE TRIGGER "trg_users_no_delete"
BEFORE DELETE ON "users"
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'ATTR table "users" forbids physical DELETE: use tombstone');
END;