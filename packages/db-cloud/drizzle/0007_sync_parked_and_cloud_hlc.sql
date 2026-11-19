CREATE TABLE "cloud_hlc_state" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"created_at_ms" bigint NOT NULL,
	"updated_at_ms" bigint NOT NULL,
	"device_id" uuid NOT NULL,
	"physical_ms" bigint NOT NULL,
	"logical" integer NOT NULL,
	"last_device_seq" bigint NOT NULL,
	CONSTRAINT "chk_cloud_hlc_state_logical" CHECK ("cloud_hlc_state"."logical" >= 0 AND "cloud_hlc_state"."logical" <= 65535)
);
--> statement-breakpoint
ALTER TABLE "cloud_hlc_state" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "cloud_sync_parked" ADD COLUMN "resolution" text;--> statement-breakpoint
ALTER TABLE "cloud_sync_parked" ADD COLUMN "resolved_by_user_id" uuid;--> statement-breakpoint
ALTER TABLE "cloud_sync_parked" ADD COLUMN "resolved_at_ms" bigint;--> statement-breakpoint
ALTER TABLE "cloud_sync_parked" ADD COLUMN "resolution_note" text;--> statement-breakpoint
CREATE UNIQUE INDEX "uidx_cloud_hlc_state_org" ON "cloud_hlc_state" USING btree ("organization_id");--> statement-breakpoint
ALTER TABLE "cloud_sync_parked" ADD CONSTRAINT "chk_cloud_sync_parked_resolution" CHECK ("cloud_sync_parked"."resolution" IS NULL OR "cloud_sync_parked"."resolution" IN ('retried', 'acknowledged'));--> statement-breakpoint
CREATE POLICY "cloud_hlc_state_tenant_isolation" ON "cloud_hlc_state" AS PERMISSIVE FOR ALL TO "mezon_app" USING ("organization_id" = mezon_current_organization_id()) WITH CHECK ("organization_id" = mezon_current_organization_id());--> statement-breakpoint
ALTER TABLE "cloud_hlc_state" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON TABLE "cloud_hlc_state" FROM mezon_app;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON TABLE "cloud_hlc_state" TO mezon_app;
