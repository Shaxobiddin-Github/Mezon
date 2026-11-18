CREATE TABLE `local_lan_identity` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`created_at_ms` integer NOT NULL,
	`updated_at_ms` integer NOT NULL,
	`cert_pem` text NOT NULL,
	`key_enc_b64` text NOT NULL,
	`fingerprint256` text NOT NULL,
	`not_after_ms` integer NOT NULL,
	`lan_enabled` integer DEFAULT 0 NOT NULL,
	CONSTRAINT "chk_local_lan_identity_created_at_ms_int" CHECK(typeof("local_lan_identity"."created_at_ms") = 'integer'),
	CONSTRAINT "chk_local_lan_identity_updated_at_ms_int" CHECK(typeof("local_lan_identity"."updated_at_ms") = 'integer'),
	CONSTRAINT "chk_local_lan_identity_not_after_ms_int" CHECK(typeof("local_lan_identity"."not_after_ms") = 'integer'),
	CONSTRAINT "chk_local_lan_identity_lan_enabled_int" CHECK(typeof("local_lan_identity"."lan_enabled") = 'integer')
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uidx_local_lan_identity_org` ON `local_lan_identity` (`organization_id`);--> statement-breakpoint
CREATE TABLE `local_lan_pairing_codes` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`created_at_ms` integer NOT NULL,
	`updated_at_ms` integer NOT NULL,
	`code_enc` text NOT NULL,
	`created_by_user_id` text NOT NULL,
	`expires_at_ms` integer NOT NULL,
	`failed_attempts` integer DEFAULT 0 NOT NULL,
	`used_at_ms` integer,
	`used_by_terminal_id` text,
	CONSTRAINT "chk_local_lan_pairing_codes_created_at_ms_int" CHECK(typeof("local_lan_pairing_codes"."created_at_ms") = 'integer'),
	CONSTRAINT "chk_local_lan_pairing_codes_updated_at_ms_int" CHECK(typeof("local_lan_pairing_codes"."updated_at_ms") = 'integer'),
	CONSTRAINT "chk_local_lan_pairing_codes_expires_at_ms_int" CHECK(typeof("local_lan_pairing_codes"."expires_at_ms") = 'integer'),
	CONSTRAINT "chk_local_lan_pairing_codes_failed_attempts_int" CHECK(typeof("local_lan_pairing_codes"."failed_attempts") = 'integer'),
	CONSTRAINT "chk_local_lan_pairing_codes_used_at_ms_int" CHECK("local_lan_pairing_codes"."used_at_ms" IS NULL OR typeof("local_lan_pairing_codes"."used_at_ms") = 'integer'),
	CONSTRAINT "chk_local_lan_pairing_codes_attempts" CHECK("local_lan_pairing_codes"."failed_attempts" >= 0)
);
--> statement-breakpoint
CREATE INDEX `idx_local_lan_pairing_codes_active` ON `local_lan_pairing_codes` (`organization_id`,`expires_at_ms`);--> statement-breakpoint
CREATE TABLE `local_lan_terminals` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`created_at_ms` integer NOT NULL,
	`updated_at_ms` integer NOT NULL,
	`name` text NOT NULL,
	`key_hash` text NOT NULL,
	`status` text NOT NULL,
	`paired_at_ms` integer NOT NULL,
	`paired_by_user_id` text NOT NULL,
	`revoked_at_ms` integer,
	`last_seen_at_ms` integer,
	CONSTRAINT "chk_local_lan_terminals_created_at_ms_int" CHECK(typeof("local_lan_terminals"."created_at_ms") = 'integer'),
	CONSTRAINT "chk_local_lan_terminals_updated_at_ms_int" CHECK(typeof("local_lan_terminals"."updated_at_ms") = 'integer'),
	CONSTRAINT "chk_local_lan_terminals_paired_at_ms_int" CHECK(typeof("local_lan_terminals"."paired_at_ms") = 'integer'),
	CONSTRAINT "chk_local_lan_terminals_revoked_at_ms_int" CHECK("local_lan_terminals"."revoked_at_ms" IS NULL OR typeof("local_lan_terminals"."revoked_at_ms") = 'integer'),
	CONSTRAINT "chk_local_lan_terminals_last_seen_at_ms_int" CHECK("local_lan_terminals"."last_seen_at_ms" IS NULL OR typeof("local_lan_terminals"."last_seen_at_ms") = 'integer'),
	CONSTRAINT "chk_local_lan_terminals_status" CHECK("local_lan_terminals"."status" IN ('active', 'revoked')),
	CONSTRAINT "chk_local_lan_terminals_revoked" CHECK(("local_lan_terminals"."status" = 'active' AND "local_lan_terminals"."revoked_at_ms" IS NULL) OR ("local_lan_terminals"."status" = 'revoked' AND "local_lan_terminals"."revoked_at_ms" IS NOT NULL)),
	CONSTRAINT "chk_local_lan_terminals_name" CHECK(length(trim("local_lan_terminals"."name")) BETWEEN 1 AND 60)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uidx_local_lan_terminals_key` ON `local_lan_terminals` (`key_hash`);