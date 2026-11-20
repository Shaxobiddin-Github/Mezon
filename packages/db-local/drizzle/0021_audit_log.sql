CREATE TABLE `local_audit_log` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`created_at_ms` integer NOT NULL,
	`updated_at_ms` integer NOT NULL,
	`seq` integer NOT NULL,
	`event_type` text NOT NULL,
	`actor_user_id` text,
	`entity` text NOT NULL,
	`entity_id` text,
	`details_json` text NOT NULL,
	`prev_hash` text NOT NULL,
	`hash` text NOT NULL,
	CONSTRAINT "chk_local_audit_log_created_at_ms_int" CHECK(typeof("local_audit_log"."created_at_ms") = 'integer'),
	CONSTRAINT "chk_local_audit_log_updated_at_ms_int" CHECK(typeof("local_audit_log"."updated_at_ms") = 'integer'),
	CONSTRAINT "chk_local_audit_log_seq_int" CHECK(typeof("local_audit_log"."seq") = 'integer'),
	CONSTRAINT "chk_local_audit_log_seq" CHECK("local_audit_log"."seq" >= 1),
	CONSTRAINT "chk_local_audit_log_hash" CHECK(length("local_audit_log"."hash") = 64 AND length("local_audit_log"."prev_hash") = 64)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uidx_local_audit_log_org_seq` ON `local_audit_log` (`organization_id`,`seq`);--> statement-breakpoint
CREATE INDEX `idx_local_audit_log_event` ON `local_audit_log` (`organization_id`,`event_type`,`created_at_ms`);--> statement-breakpoint
DROP TRIGGER IF EXISTS "trg_local_audit_log_no_update";
--> statement-breakpoint
DROP TRIGGER IF EXISTS "trg_local_audit_log_no_delete";
--> statement-breakpoint
CREATE TRIGGER "trg_local_audit_log_no_update"
BEFORE UPDATE ON "local_audit_log"
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'local_audit_log is append-only');
END;
--> statement-breakpoint
CREATE TRIGGER "trg_local_audit_log_no_delete"
BEFORE DELETE ON "local_audit_log"
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'local_audit_log is append-only');
END;
