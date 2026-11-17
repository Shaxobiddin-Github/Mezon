CREATE TABLE "fiscal_docs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"store_id" uuid NOT NULL,
	"device_id" uuid NOT NULL,
	"hlc" text NOT NULL,
	"created_at_ms" bigint NOT NULL,
	"updated_at_ms" bigint NOT NULL,
	"doc_kind" text NOT NULL,
	"sale_id" uuid,
	"return_id" uuid,
	"shift_id" uuid,
	"depends_on_doc_id" uuid,
	"idempotency_key" text NOT NULL,
	"status" text NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_check_at_ms" bigint NOT NULL,
	"last_error_code" text,
	"last_error_message" text,
	"sent_at_ms" bigint,
	"confirmed_at_ms" bigint,
	"cancelled_at_ms" bigint,
	"fiscal_sign" text,
	"fiscal_number" text,
	"qr_payload" text,
	"driver_id" text NOT NULL,
	"offline_deadline_ms" bigint NOT NULL,
	CONSTRAINT "chk_fiscal_docs_hlc_len" CHECK (length("fiscal_docs"."hlc") = 58),
	CONSTRAINT "chk_fiscal_docs_kind" CHECK ("fiscal_docs"."doc_kind" IN ('sale', 'refund', 'shift_open', 'shift_close')),
	CONSTRAINT "chk_fiscal_docs_status" CHECK ("fiscal_docs"."status" IN ('pending', 'sent', 'confirmed', 'failed', 'rejected', 'cancelled')),
	CONSTRAINT "chk_fiscal_docs_kind_refs" CHECK (("fiscal_docs"."doc_kind" = 'sale' AND "fiscal_docs"."sale_id" IS NOT NULL AND "fiscal_docs"."return_id" IS NULL AND "fiscal_docs"."shift_id" IS NULL AND "fiscal_docs"."depends_on_doc_id" IS NULL) OR ("fiscal_docs"."doc_kind" = 'refund' AND "fiscal_docs"."sale_id" IS NOT NULL AND "fiscal_docs"."return_id" IS NOT NULL AND "fiscal_docs"."shift_id" IS NULL) OR ("fiscal_docs"."doc_kind" IN ('shift_open', 'shift_close') AND "fiscal_docs"."shift_id" IS NOT NULL AND "fiscal_docs"."sale_id" IS NULL AND "fiscal_docs"."return_id" IS NULL AND "fiscal_docs"."depends_on_doc_id" IS NULL)),
	CONSTRAINT "chk_fiscal_docs_idem_nonempty" CHECK (length(trim("fiscal_docs"."idempotency_key")) >= 1),
	CONSTRAINT "chk_fiscal_docs_driver_nonempty" CHECK (length(trim("fiscal_docs"."driver_id")) >= 1),
	CONSTRAINT "chk_fiscal_docs_attempts" CHECK ("fiscal_docs"."attempts" >= 0),
	CONSTRAINT "chk_fiscal_docs_confirmed_fields" CHECK (("fiscal_docs"."status" = 'confirmed' AND "fiscal_docs"."fiscal_sign" IS NOT NULL AND length(trim("fiscal_docs"."fiscal_sign")) >= 1 AND "fiscal_docs"."fiscal_number" IS NOT NULL AND length(trim("fiscal_docs"."fiscal_number")) >= 1 AND "fiscal_docs"."qr_payload" IS NOT NULL AND length("fiscal_docs"."qr_payload") >= 1 AND "fiscal_docs"."confirmed_at_ms" IS NOT NULL AND "fiscal_docs"."sent_at_ms" IS NOT NULL) OR ("fiscal_docs"."status" <> 'confirmed' AND "fiscal_docs"."fiscal_sign" IS NULL AND "fiscal_docs"."fiscal_number" IS NULL AND "fiscal_docs"."qr_payload" IS NULL AND "fiscal_docs"."confirmed_at_ms" IS NULL)),
	CONSTRAINT "chk_fiscal_docs_sent_at" CHECK ("fiscal_docs"."status" NOT IN ('sent', 'rejected') OR "fiscal_docs"."sent_at_ms" IS NOT NULL),
	CONSTRAINT "chk_fiscal_docs_cancelled_at" CHECK (("fiscal_docs"."status" = 'cancelled') = ("fiscal_docs"."cancelled_at_ms" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "fiscal_docs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "fiscal_docs" ADD CONSTRAINT "fiscal_docs_sale_id_sales_id_fk" FOREIGN KEY ("sale_id") REFERENCES "public"."sales"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fiscal_docs" ADD CONSTRAINT "fiscal_docs_return_id_returns_id_fk" FOREIGN KEY ("return_id") REFERENCES "public"."returns"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fiscal_docs" ADD CONSTRAINT "fiscal_docs_shift_id_shifts_id_fk" FOREIGN KEY ("shift_id") REFERENCES "public"."shifts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fiscal_docs" ADD CONSTRAINT "fiscal_docs_depends_on_doc_id_fiscal_docs_id_fk" FOREIGN KEY ("depends_on_doc_id") REFERENCES "public"."fiscal_docs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uidx_fiscal_docs_org_idem" ON "fiscal_docs" USING btree ("organization_id","idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "uidx_fiscal_docs_sale" ON "fiscal_docs" USING btree ("sale_id") WHERE "fiscal_docs"."doc_kind" = 'sale';--> statement-breakpoint
CREATE UNIQUE INDEX "uidx_fiscal_docs_return" ON "fiscal_docs" USING btree ("return_id") WHERE "fiscal_docs"."return_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_fiscal_docs_status" ON "fiscal_docs" USING btree ("organization_id","store_id","status");--> statement-breakpoint
CREATE POLICY "fiscal_docs_tenant_isolation" ON "fiscal_docs" AS PERMISSIVE FOR ALL TO "mezon_app" USING ("organization_id" = mezon_current_organization_id()) WITH CHECK ("organization_id" = mezon_current_organization_id());--> statement-breakpoint
ALTER TABLE "fiscal_docs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "fiscal_docs" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "fiscal_docs_tenant_isolation" ON "fiscal_docs";--> statement-breakpoint
CREATE POLICY "fiscal_docs_tenant_isolation" ON "fiscal_docs" AS PERMISSIVE FOR ALL TO "mezon_app" USING ("organization_id" = mezon_current_organization_id()) WITH CHECK ("organization_id" = mezon_current_organization_id());--> statement-breakpoint
REVOKE ALL ON TABLE "fiscal_docs" FROM "mezon_app";--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON TABLE "fiscal_docs" TO "mezon_app";
