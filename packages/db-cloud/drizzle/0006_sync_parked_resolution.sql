ALTER TABLE "cloud_sync_parked" ADD COLUMN "resolution" text;--> statement-breakpoint
ALTER TABLE "cloud_sync_parked" ADD COLUMN "resolved_by_user_id" uuid;--> statement-breakpoint
ALTER TABLE "cloud_sync_parked" ADD COLUMN "resolved_at_ms" bigint;--> statement-breakpoint
ALTER TABLE "cloud_sync_parked" ADD COLUMN "resolution_note" text;--> statement-breakpoint
ALTER TABLE "cloud_sync_parked" ADD CONSTRAINT "chk_cloud_sync_parked_resolution" CHECK ("cloud_sync_parked"."resolution" IS NULL OR "cloud_sync_parked"."resolution" IN ('retried', 'acknowledged'));