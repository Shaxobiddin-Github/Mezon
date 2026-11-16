CREATE TABLE "cloud_store_sync_positions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"created_at_ms" bigint NOT NULL,
	"updated_at_ms" bigint NOT NULL,
	"store_id" uuid NOT NULL,
	"last_position" bigint DEFAULT 0 NOT NULL
);
--> statement-breakpoint
ALTER TABLE "cloud_store_sync_positions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "cloud_sync_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"device_id" uuid NOT NULL,
	"hlc" text NOT NULL,
	"created_at_ms" bigint NOT NULL,
	"store_id" uuid NOT NULL,
	"device_seq" bigint NOT NULL,
	"type" text NOT NULL,
	"entity" text NOT NULL,
	"entity_id" uuid NOT NULL,
	"class" text NOT NULL,
	"schema_version" integer NOT NULL,
	"payload" text NOT NULL,
	"position" bigint NOT NULL,
	"hlc_adjusted" boolean DEFAULT false NOT NULL,
	"received_at_ms" bigint NOT NULL,
	CONSTRAINT "chk_cloud_sync_events_hlc_len" CHECK (length("cloud_sync_events"."hlc") = 58)
);
--> statement-breakpoint
ALTER TABLE "cloud_sync_events" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "cloud_sync_parked" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"created_at_ms" bigint NOT NULL,
	"updated_at_ms" bigint NOT NULL,
	"store_id" uuid NOT NULL,
	"device_id" uuid NOT NULL,
	"event_id" uuid NOT NULL,
	"entity" text NOT NULL,
	"entity_id" uuid NOT NULL,
	"missing_ref_entity" text NOT NULL,
	"missing_ref_id" uuid NOT NULL,
	"attempts" integer DEFAULT 1 NOT NULL,
	"event_payload" text NOT NULL,
	"status" text DEFAULT 'parked' NOT NULL
);
--> statement-breakpoint
ALTER TABLE "cloud_sync_parked" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "batches" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"store_id" uuid NOT NULL,
	"device_id" uuid NOT NULL,
	"hlc" text NOT NULL,
	"created_at_ms" bigint NOT NULL,
	"product_id" uuid NOT NULL,
	"variant_id" uuid,
	"batch_number" text,
	"expiry_date_ms" bigint,
	"initial_qty" bigint NOT NULL,
	"initial_cost_value" bigint NOT NULL,
	"supplier_id" uuid,
	CONSTRAINT "chk_batches_hlc_len" CHECK (length("batches"."hlc") = 58),
	CONSTRAINT "chk_batches_initial_qty_pos" CHECK ("batches"."initial_qty" > 0),
	CONSTRAINT "chk_batches_initial_cost_nonneg" CHECK ("batches"."initial_cost_value" >= 0)
);
--> statement-breakpoint
ALTER TABLE "batches" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "cash_moves" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"store_id" uuid NOT NULL,
	"device_id" uuid NOT NULL,
	"hlc" text NOT NULL,
	"created_at_ms" bigint NOT NULL,
	"shift_id" uuid,
	"shift_cashier_session_id" uuid,
	"type" text NOT NULL,
	"amount_delta" bigint NOT NULL,
	"source_type" text NOT NULL,
	"source_id" uuid NOT NULL,
	"payment_id" uuid,
	"expense_category" text,
	"reason" text,
	"created_by_user_id" uuid NOT NULL,
	CONSTRAINT "chk_cash_moves_hlc_len" CHECK (length("cash_moves"."hlc") = 58),
	CONSTRAINT "chk_cash_moves_type" CHECK ("cash_moves"."type" IN ('sale_cash_in', 'debt_payment_in', 'cash_in', 'advance_cash_in', 'sale_change_out', 'refund_cash_out', 'supplier_payment_out', 'cash_out', 'encashment', 'advance_change_out', 'advance_refund_out')),
	CONSTRAINT "chk_cash_moves_amount_sign" CHECK (("cash_moves"."type" IN ('sale_cash_in', 'debt_payment_in', 'cash_in', 'advance_cash_in') AND "cash_moves"."amount_delta" > 0) OR ("cash_moves"."type" IN ('sale_change_out', 'refund_cash_out', 'supplier_payment_out', 'cash_out', 'encashment', 'advance_change_out', 'advance_refund_out') AND "cash_moves"."amount_delta" < 0)),
	CONSTRAINT "chk_cash_moves_source_type" CHECK (length(trim("cash_moves"."source_type")) >= 1)
);
--> statement-breakpoint
ALTER TABLE "cash_moves" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "categories" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"device_id" uuid NOT NULL,
	"hlc" text NOT NULL,
	"created_at_ms" bigint NOT NULL,
	"updated_at_ms" bigint NOT NULL,
	"deleted_at_ms" bigint,
	"name" text NOT NULL,
	"name_search" text NOT NULL,
	"parent_id" uuid,
	"sort_order" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "chk_categories_hlc_len" CHECK (length("categories"."hlc") = 58),
	CONSTRAINT "chk_categories_name_nonempty" CHECK (length(trim("categories"."name")) >= 1),
	CONSTRAINT "chk_categories_not_self_parent" CHECK ("categories"."parent_id" IS NULL OR "categories"."parent_id" <> "categories"."id")
);
--> statement-breakpoint
ALTER TABLE "categories" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "customer_ledger" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"store_id" uuid NOT NULL,
	"device_id" uuid NOT NULL,
	"hlc" text NOT NULL,
	"created_at_ms" bigint NOT NULL,
	"customer_id" uuid NOT NULL,
	"entry_type" text NOT NULL,
	"amount_delta" bigint NOT NULL,
	"source_type" text NOT NULL,
	"source_id" uuid NOT NULL,
	"sale_id" uuid,
	"payment_method" text,
	"provider_ref" text,
	"cash_move_id" uuid,
	"due_at_ms" bigint,
	"reason" text,
	"created_by_user_id" uuid NOT NULL,
	"override_approved_by_user_id" uuid,
	"client_request_id" uuid,
	"request_hash" text,
	CONSTRAINT "chk_customer_ledger_hlc_len" CHECK (length("customer_ledger"."hlc") = 58),
	CONSTRAINT "chk_customer_ledger_entry_type" CHECK ("customer_ledger"."entry_type" IN ('opening_balance', 'sale_debt', 'debt_payment', 'return_offset', 'adjustment')),
	CONSTRAINT "chk_customer_ledger_source_type" CHECK ("customer_ledger"."source_type" IN ('opening_balance', 'sale', 'debt_payment', 'sale_void', 'return', 'adjustment')),
	CONSTRAINT "chk_customer_ledger_delta_sign" CHECK (("customer_ledger"."entry_type" IN ('opening_balance', 'sale_debt') AND "customer_ledger"."amount_delta" > 0) OR ("customer_ledger"."entry_type" IN ('debt_payment', 'return_offset') AND "customer_ledger"."amount_delta" < 0) OR ("customer_ledger"."entry_type" = 'adjustment' AND "customer_ledger"."amount_delta" <> 0)),
	CONSTRAINT "chk_customer_ledger_payment_fields" CHECK (("customer_ledger"."entry_type" = 'debt_payment' AND "customer_ledger"."payment_method" IN ('cash', 'card', 'uzqr', 'payme', 'click', 'uzum', 'social_card', 'other') AND (("customer_ledger"."payment_method" = 'cash' AND "customer_ledger"."cash_move_id" IS NOT NULL AND "customer_ledger"."provider_ref" IS NULL) OR ("customer_ledger"."payment_method" <> 'cash' AND "customer_ledger"."cash_move_id" IS NULL))) OR ("customer_ledger"."entry_type" <> 'debt_payment' AND "customer_ledger"."payment_method" IS NULL AND "customer_ledger"."provider_ref" IS NULL AND "customer_ledger"."cash_move_id" IS NULL)),
	CONSTRAINT "chk_customer_ledger_sale_ref" CHECK (("customer_ledger"."entry_type" IN ('sale_debt', 'return_offset') AND "customer_ledger"."sale_id" IS NOT NULL) OR ("customer_ledger"."entry_type" IN ('opening_balance', 'debt_payment', 'adjustment'))),
	CONSTRAINT "chk_customer_ledger_reason_req" CHECK ("customer_ledger"."entry_type" NOT IN ('opening_balance', 'adjustment') OR ("customer_ledger"."reason" IS NOT NULL AND length(trim("customer_ledger"."reason")) >= 1)),
	CONSTRAINT "chk_customer_ledger_req_pair" CHECK (("customer_ledger"."client_request_id" IS NULL AND "customer_ledger"."request_hash" IS NULL) OR ("customer_ledger"."client_request_id" IS NOT NULL AND "customer_ledger"."request_hash" IS NOT NULL AND length(trim("customer_ledger"."request_hash")) >= 6))
);
--> statement-breakpoint
ALTER TABLE "customer_ledger" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "customers" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"device_id" uuid NOT NULL,
	"hlc" text NOT NULL,
	"created_at_ms" bigint NOT NULL,
	"updated_at_ms" bigint NOT NULL,
	"deleted_at_ms" bigint,
	"full_name" text NOT NULL,
	"name_search" text NOT NULL,
	"phone_normalized" text,
	"phone_digits" text,
	"credit_limit" bigint,
	"default_due_days" integer,
	"note" text,
	"is_active" boolean DEFAULT true NOT NULL,
	CONSTRAINT "chk_customers_hlc_len" CHECK (length("customers"."hlc") = 58),
	CONSTRAINT "chk_customers_name_nonempty" CHECK (length(trim("customers"."full_name")) >= 1),
	CONSTRAINT "chk_customers_phone_e164" CHECK ("customers"."phone_normalized" IS NULL OR ("customers"."phone_normalized" ~ '^\+[1-9]' AND length("customers"."phone_normalized") BETWEEN 9 AND 16)),
	CONSTRAINT "chk_customers_phone_pair" CHECK (("customers"."phone_normalized" IS NULL AND "customers"."phone_digits" IS NULL) OR ("customers"."phone_normalized" IS NOT NULL AND "customers"."phone_digits" IS NOT NULL AND "customers"."phone_normalized" = ('+' || "customers"."phone_digits"))),
	CONSTRAINT "chk_customers_credit_nonneg" CHECK ("customers"."credit_limit" IS NULL OR "customers"."credit_limit" >= 0),
	CONSTRAINT "chk_customers_due_days" CHECK ("customers"."default_due_days" IS NULL OR ("customers"."default_due_days" >= 1 AND "customers"."default_due_days" <= 3650))
);
--> statement-breakpoint
ALTER TABLE "customers" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "day_closes" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"store_id" uuid NOT NULL,
	"device_id" uuid NOT NULL,
	"hlc" text NOT NULL,
	"created_at_ms" bigint NOT NULL,
	"business_date" text NOT NULL,
	"close_seq" integer NOT NULL,
	"close_code" text NOT NULL,
	"closed_by_user_id" uuid NOT NULL,
	"client_request_id" uuid NOT NULL,
	"request_hash" text NOT NULL,
	"note" text,
	"shifts_count" integer NOT NULL,
	"sales_count" integer NOT NULL,
	"returns_count" integer NOT NULL,
	"voids_count" integer NOT NULL,
	"gross_sales_total" bigint NOT NULL,
	"returns_total" bigint NOT NULL,
	"net_sales_total" bigint NOT NULL,
	"expected_cash_total" bigint NOT NULL,
	"counted_cash_total" bigint NOT NULL,
	"discrepancy_total" bigint NOT NULL,
	"method_totals_json" text NOT NULL,
	"included_closure_ids_json" text NOT NULL,
	"fiscal_status" text DEFAULT 'not_fiscalized' NOT NULL,
	"fiscal_report_no" text,
	CONSTRAINT "chk_day_closes_hlc_len" CHECK (length("day_closes"."hlc") = 58),
	CONSTRAINT "chk_day_closes_seq_pos" CHECK ("day_closes"."close_seq" >= 1),
	CONSTRAINT "chk_day_closes_date_len" CHECK (length("day_closes"."business_date") = 10),
	CONSTRAINT "chk_day_closes_code_nonempty" CHECK (length(trim("day_closes"."close_code")) >= 1),
	CONSTRAINT "chk_day_closes_req_hash" CHECK (length(trim("day_closes"."request_hash")) >= 6),
	CONSTRAINT "chk_day_closes_fiscal_status" CHECK ("day_closes"."fiscal_status" IN ('not_fiscalized', 'pending', 'fiscalized')),
	CONSTRAINT "chk_day_closes_nonneg" CHECK ("day_closes"."shifts_count" >= 0 AND "day_closes"."sales_count" >= 0 AND "day_closes"."returns_count" >= 0 AND "day_closes"."voids_count" >= 0 AND "day_closes"."gross_sales_total" >= 0 AND "day_closes"."returns_total" >= 0 AND "day_closes"."counted_cash_total" >= 0)
);
--> statement-breakpoint
ALTER TABLE "day_closes" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "goods_receiving_lines" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"store_id" uuid NOT NULL,
	"device_id" uuid NOT NULL,
	"hlc" text NOT NULL,
	"created_at_ms" bigint NOT NULL,
	"receiving_id" uuid NOT NULL,
	"sort_order" integer NOT NULL,
	"product_id" uuid NOT NULL,
	"variant_id" uuid,
	"qty" bigint NOT NULL,
	"cost_unknown" boolean NOT NULL,
	"initial_total_cost" bigint NOT NULL,
	"vat_rate_bp" integer,
	"vat_amount" bigint,
	"stock_move_id" uuid NOT NULL,
	"batch_id" uuid,
	"batch_number" text,
	"expiry_date_ms" bigint,
	CONSTRAINT "chk_goods_receiving_lines_hlc_len" CHECK (length("goods_receiving_lines"."hlc") = 58),
	CONSTRAINT "chk_goods_receiving_lines_sort_nonneg" CHECK ("goods_receiving_lines"."sort_order" >= 0),
	CONSTRAINT "chk_goods_receiving_lines_qty_pos" CHECK ("goods_receiving_lines"."qty" > 0),
	CONSTRAINT "chk_goods_receiving_lines_cost_pair" CHECK (("goods_receiving_lines"."cost_unknown" = true AND "goods_receiving_lines"."initial_total_cost" = 0) OR ("goods_receiving_lines"."cost_unknown" = false AND "goods_receiving_lines"."initial_total_cost" >= 0)),
	CONSTRAINT "chk_goods_receiving_lines_vat_bp" CHECK ("goods_receiving_lines"."vat_rate_bp" IS NULL OR ("goods_receiving_lines"."vat_rate_bp" >= 0 AND "goods_receiving_lines"."vat_rate_bp" <= 10000)),
	CONSTRAINT "chk_goods_receiving_lines_vat_amt" CHECK ("goods_receiving_lines"."vat_amount" IS NULL OR "goods_receiving_lines"."vat_amount" >= 0)
);
--> statement-breakpoint
ALTER TABLE "goods_receiving_lines" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "goods_receivings" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"store_id" uuid NOT NULL,
	"device_id" uuid NOT NULL,
	"hlc" text NOT NULL,
	"created_at_ms" bigint NOT NULL,
	"receiving_no" bigint NOT NULL,
	"receiving_code" text NOT NULL,
	"supplier_id" uuid NOT NULL,
	"supplier_invoice_no" text,
	"due_days" integer,
	"due_at_ms" bigint,
	"known_cost_total" bigint NOT NULL,
	"unknown_cost_line_count" integer NOT NULL,
	"note" text,
	"posted_by_user_id" uuid NOT NULL,
	"client_request_id" uuid NOT NULL,
	"request_hash" text NOT NULL,
	CONSTRAINT "chk_goods_receivings_hlc_len" CHECK (length("goods_receivings"."hlc") = 58),
	CONSTRAINT "chk_goods_receivings_no_pos" CHECK ("goods_receivings"."receiving_no" >= 1),
	CONSTRAINT "chk_goods_receivings_code_nonempty" CHECK (length(trim("goods_receivings"."receiving_code")) >= 1),
	CONSTRAINT "chk_goods_receivings_known_nonneg" CHECK ("goods_receivings"."known_cost_total" >= 0),
	CONSTRAINT "chk_goods_receivings_unk_cnt_nonneg" CHECK ("goods_receivings"."unknown_cost_line_count" >= 0),
	CONSTRAINT "chk_goods_receivings_req_hash_nonempty" CHECK (length(trim("goods_receivings"."request_hash")) >= 6)
);
--> statement-breakpoint
ALTER TABLE "goods_receivings" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "inventory_count_lines" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"store_id" uuid NOT NULL,
	"device_id" uuid NOT NULL,
	"hlc" text NOT NULL,
	"created_at_ms" bigint NOT NULL,
	"updated_at_ms" bigint NOT NULL,
	"count_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"variant_id" uuid,
	"expected_qty_at_count" bigint,
	"counted_qty" bigint,
	"adjustment_qty" bigint,
	CONSTRAINT "chk_inventory_count_lines_hlc_len" CHECK (length("inventory_count_lines"."hlc") = 58),
	CONSTRAINT "chk_inv_count_lines_counted_snapshot" CHECK ("inventory_count_lines"."counted_qty" IS NULL OR ("inventory_count_lines"."counted_qty" >= 0 AND "inventory_count_lines"."expected_qty_at_count" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "inventory_count_lines" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "inventory_counts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"store_id" uuid NOT NULL,
	"device_id" uuid NOT NULL,
	"hlc" text NOT NULL,
	"created_at_ms" bigint NOT NULL,
	"updated_at_ms" bigint NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"started_by_user_id" uuid NOT NULL,
	"finalized_by_user_id" uuid,
	"finalized_at_ms" bigint,
	"note" text,
	CONSTRAINT "chk_inventory_counts_hlc_len" CHECK (length("inventory_counts"."hlc") = 58),
	CONSTRAINT "chk_inventory_counts_status" CHECK ("inventory_counts"."status" IN ('open', 'finalized', 'cancelled')),
	CONSTRAINT "chk_inventory_counts_finalized_consistency" CHECK (("inventory_counts"."status" = 'open' AND "inventory_counts"."finalized_at_ms" IS NULL) OR ("inventory_counts"."status" <> 'open' AND "inventory_counts"."finalized_at_ms" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "inventory_counts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "order_lines" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"store_id" uuid NOT NULL,
	"device_id" uuid NOT NULL,
	"hlc" text NOT NULL,
	"created_at_ms" bigint NOT NULL,
	"order_id" uuid NOT NULL,
	"sort_order" integer NOT NULL,
	"line_kind" text NOT NULL,
	"product_id" uuid,
	"variant_id" uuid,
	"category_id_snapshot" uuid,
	"item_name" text NOT NULL,
	"unit" text NOT NULL,
	"qty" bigint NOT NULL,
	"unit_price_snapshot" bigint NOT NULL,
	"applied_promotion_id" uuid,
	"applied_promotion_name" text,
	"free_units" bigint DEFAULT 0 NOT NULL,
	"gross_total" bigint NOT NULL,
	"promo_discount" bigint NOT NULL,
	"subtotal_after_promo" bigint NOT NULL,
	"allocated_order_discount" bigint NOT NULL,
	"final_total" bigint NOT NULL,
	"vat_rate_bp_snapshot" integer NOT NULL,
	"net_ex_vat" bigint NOT NULL,
	"vat_total" bigint NOT NULL,
	"mxik_snapshot" text,
	"package_code_snapshot" text,
	CONSTRAINT "chk_order_lines_hlc_len" CHECK (length("order_lines"."hlc") = 58),
	CONSTRAINT "chk_order_lines_sort_nonneg" CHECK ("order_lines"."sort_order" >= 0),
	CONSTRAINT "chk_order_lines_kind" CHECK ("order_lines"."line_kind" IN ('catalog', 'quick_sale')),
	CONSTRAINT "chk_order_lines_kind_product" CHECK (("order_lines"."line_kind" = 'catalog' AND "order_lines"."product_id" IS NOT NULL) OR ("order_lines"."line_kind" = 'quick_sale' AND "order_lines"."product_id" IS NULL AND "order_lines"."variant_id" IS NULL)),
	CONSTRAINT "chk_order_lines_name_nonempty" CHECK (length(trim("order_lines"."item_name")) >= 1),
	CONSTRAINT "chk_order_lines_unit" CHECK ("order_lines"."unit" IN ('dona', 'kg', 'g', 'litr', 'metr', 'm2', 'qadoq')),
	CONSTRAINT "chk_order_lines_qty_pos" CHECK ("order_lines"."qty" > 0),
	CONSTRAINT "chk_order_lines_unit_int" CHECK ("order_lines"."unit" NOT IN ('dona', 'qadoq') OR ("order_lines"."qty" % 1000) = 0),
	CONSTRAINT "chk_order_lines_money_nonneg" CHECK ("order_lines"."unit_price_snapshot" >= 0 AND "order_lines"."free_units" >= 0 AND "order_lines"."gross_total" >= 0 AND "order_lines"."promo_discount" >= 0 AND "order_lines"."subtotal_after_promo" >= 0 AND "order_lines"."allocated_order_discount" >= 0 AND "order_lines"."final_total" >= 0 AND "order_lines"."net_ex_vat" >= 0 AND "order_lines"."vat_total" >= 0),
	CONSTRAINT "chk_order_lines_vat_bp" CHECK ("order_lines"."vat_rate_bp_snapshot" >= 0 AND "order_lines"."vat_rate_bp_snapshot" <= 10000),
	CONSTRAINT "chk_order_lines_arithmetic" CHECK ("order_lines"."subtotal_after_promo" = "order_lines"."gross_total" - "order_lines"."promo_discount" AND "order_lines"."final_total" = "order_lines"."subtotal_after_promo" - "order_lines"."allocated_order_discount" AND "order_lines"."net_ex_vat" + "order_lines"."vat_total" = "order_lines"."final_total")
);
--> statement-breakpoint
ALTER TABLE "order_lines" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "order_payments" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"store_id" uuid NOT NULL,
	"device_id" uuid NOT NULL,
	"hlc" text NOT NULL,
	"created_at_ms" bigint NOT NULL,
	"order_id" uuid NOT NULL,
	"shift_id" uuid NOT NULL,
	"shift_cashier_session_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"method" text NOT NULL,
	"amount" bigint NOT NULL,
	"tendered_amount" bigint,
	"change_amount" bigint DEFAULT 0 NOT NULL,
	"provider_ref" text,
	"reason" text,
	"created_by_user_id" uuid NOT NULL,
	"override_approved_by_user_id" uuid,
	"seq" integer DEFAULT 0 NOT NULL,
	"client_request_id" uuid NOT NULL,
	"request_hash" text NOT NULL,
	CONSTRAINT "chk_order_payments_hlc_len" CHECK (length("order_payments"."hlc") = 58),
	CONSTRAINT "chk_order_payments_seq_nonneg" CHECK ("order_payments"."seq" >= 0),
	CONSTRAINT "chk_order_payments_kind" CHECK ("order_payments"."kind" IN ('advance', 'advance_refund')),
	CONSTRAINT "chk_order_payments_method" CHECK ("order_payments"."method" IN ('cash', 'card', 'uzqr', 'payme', 'click', 'uzum', 'social_card', 'other')),
	CONSTRAINT "chk_order_payments_amt_pos" CHECK ("order_payments"."amount" > 0 AND "order_payments"."change_amount" >= 0),
	CONSTRAINT "chk_order_payments_req_hash" CHECK (length(trim("order_payments"."request_hash")) >= 6),
	CONSTRAINT "chk_order_payments_cash_pair" CHECK (("order_payments"."kind" = 'advance' AND "order_payments"."method" = 'cash' AND "order_payments"."tendered_amount" IS NOT NULL AND "order_payments"."tendered_amount" >= "order_payments"."amount" AND "order_payments"."tendered_amount" - "order_payments"."change_amount" = "order_payments"."amount") OR (("order_payments"."kind" <> 'advance' OR "order_payments"."method" <> 'cash') AND "order_payments"."tendered_amount" IS NULL AND "order_payments"."change_amount" = 0)),
	CONSTRAINT "chk_order_payments_refund_reason" CHECK ("order_payments"."kind" <> 'advance_refund' OR ("order_payments"."reason" IS NOT NULL AND length(trim("order_payments"."reason")) >= 1))
);
--> statement-breakpoint
ALTER TABLE "order_payments" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "orders" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"store_id" uuid NOT NULL,
	"device_id" uuid NOT NULL,
	"hlc" text NOT NULL,
	"created_at_ms" bigint NOT NULL,
	"updated_at_ms" bigint NOT NULL,
	"origin_device_id" uuid NOT NULL,
	"order_no" bigint NOT NULL,
	"order_code" text NOT NULL,
	"status" text NOT NULL,
	"customer_id" uuid,
	"customer_name" text NOT NULL,
	"customer_phone_normalized" text,
	"due_at_ms" bigint,
	"note" text,
	"subtotal_gross" bigint NOT NULL,
	"total_promo_discount" bigint NOT NULL,
	"subtotal_after_promo" bigint NOT NULL,
	"manual_discount_mode" text NOT NULL,
	"manual_discount_value" bigint NOT NULL,
	"manual_discount_reason" text,
	"order_discount_amount" bigint NOT NULL,
	"total_amount" bigint NOT NULL,
	"total_net_ex_vat" bigint NOT NULL,
	"total_vat" bigint NOT NULL,
	"override_approved_by_user_id" uuid,
	"override_approved_amount" bigint,
	"created_by_user_id" uuid NOT NULL,
	"confirmed_at_ms" bigint,
	"ready_at_ms" bigint,
	"delivered_at_ms" bigint,
	"delivered_sale_id" uuid,
	"cancelled_at_ms" bigint,
	"cancelled_by_user_id" uuid,
	"cancel_reason" text,
	"create_client_request_id" uuid NOT NULL,
	"create_request_hash" text NOT NULL,
	"confirm_client_request_id" uuid,
	"confirm_request_hash" text,
	"ready_client_request_id" uuid,
	"ready_request_hash" text,
	"deliver_client_request_id" uuid,
	"deliver_request_hash" text,
	"cancel_client_request_id" uuid,
	"cancel_request_hash" text,
	CONSTRAINT "chk_orders_hlc_len" CHECK (length("orders"."hlc") = 58),
	CONSTRAINT "chk_orders_no_pos" CHECK ("orders"."order_no" >= 1),
	CONSTRAINT "chk_orders_code_nonempty" CHECK (length(trim("orders"."order_code")) >= 1),
	CONSTRAINT "chk_orders_status" CHECK ("orders"."status" IN ('draft', 'confirmed', 'ready', 'delivered', 'cancelled')),
	CONSTRAINT "chk_orders_cust_name_nonempty" CHECK (length(trim("orders"."customer_name")) >= 1),
	CONSTRAINT "chk_orders_create_req_hash" CHECK (length(trim("orders"."create_request_hash")) >= 6),
	CONSTRAINT "chk_orders_disc_mode" CHECK ("orders"."manual_discount_mode" IN ('none', 'percent', 'amount')),
	CONSTRAINT "chk_orders_disc_val" CHECK (("orders"."manual_discount_mode" = 'none' AND "orders"."manual_discount_value" = 0) OR ("orders"."manual_discount_mode" = 'percent' AND "orders"."manual_discount_value" BETWEEN 1 AND 10000) OR ("orders"."manual_discount_mode" = 'amount' AND "orders"."manual_discount_value" > 0)),
	CONSTRAINT "chk_orders_money_nonneg" CHECK ("orders"."subtotal_gross" >= 0 AND "orders"."total_promo_discount" >= 0 AND "orders"."subtotal_after_promo" >= 0 AND "orders"."order_discount_amount" >= 0 AND "orders"."total_amount" >= 0 AND "orders"."total_net_ex_vat" >= 0 AND "orders"."total_vat" >= 0),
	CONSTRAINT "chk_orders_totals_balance" CHECK ("orders"."total_net_ex_vat" + "orders"."total_vat" = "orders"."total_amount"),
	CONSTRAINT "chk_orders_override_pair" CHECK (("orders"."override_approved_by_user_id" IS NULL AND "orders"."override_approved_amount" IS NULL) OR ("orders"."override_approved_by_user_id" IS NOT NULL AND "orders"."override_approved_amount" >= 0)),
	CONSTRAINT "chk_orders_delivered_pair" CHECK (("orders"."status" <> 'delivered' AND "orders"."delivered_at_ms" IS NULL AND "orders"."delivered_sale_id" IS NULL) OR ("orders"."status" = 'delivered' AND "orders"."delivered_at_ms" IS NOT NULL AND "orders"."delivered_sale_id" IS NOT NULL)),
	CONSTRAINT "chk_orders_cancelled_pair" CHECK (("orders"."status" <> 'cancelled' AND "orders"."cancelled_at_ms" IS NULL AND "orders"."cancelled_by_user_id" IS NULL AND "orders"."cancel_reason" IS NULL) OR ("orders"."status" = 'cancelled' AND "orders"."cancelled_at_ms" IS NOT NULL AND "orders"."cancelled_by_user_id" IS NOT NULL AND "orders"."cancel_reason" IS NOT NULL AND length(trim("orders"."cancel_reason")) >= 1))
);
--> statement-breakpoint
ALTER TABLE "orders" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "payments" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"store_id" uuid NOT NULL,
	"device_id" uuid NOT NULL,
	"hlc" text NOT NULL,
	"created_at_ms" bigint NOT NULL,
	"sale_id" uuid NOT NULL,
	"method" text NOT NULL,
	"amount" bigint NOT NULL,
	"tendered_amount" bigint,
	"change_amount" bigint DEFAULT 0 NOT NULL,
	"provider_ref" text,
	"provider_meta_json" text,
	CONSTRAINT "chk_payments_hlc_len" CHECK (length("payments"."hlc") = 58),
	CONSTRAINT "chk_payments_method" CHECK ("payments"."method" IN ('cash', 'card', 'uzqr', 'payme', 'click', 'uzum', 'social_card', 'other', 'advance')),
	CONSTRAINT "chk_payments_nonneg" CHECK ("payments"."amount" > 0 AND "payments"."change_amount" >= 0),
	CONSTRAINT "chk_payments_cash_balance" CHECK (("payments"."method" = 'cash' AND "payments"."tendered_amount" IS NOT NULL AND "payments"."tendered_amount" > 0 AND "payments"."tendered_amount" >= "payments"."amount" AND "payments"."tendered_amount" - "payments"."change_amount" = "payments"."amount") OR ("payments"."method" <> 'cash' AND "payments"."tendered_amount" IS NULL AND "payments"."change_amount" = 0))
);
--> statement-breakpoint
ALTER TABLE "payments" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "price_changes" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"device_id" uuid NOT NULL,
	"hlc" text NOT NULL,
	"created_at_ms" bigint NOT NULL,
	"product_id" uuid NOT NULL,
	"variant_id" uuid,
	"old_price" bigint,
	"new_price" bigint NOT NULL,
	"changed_by_user_id" uuid NOT NULL,
	"reason" text,
	CONSTRAINT "chk_price_changes_hlc_len" CHECK (length("price_changes"."hlc") = 58),
	CONSTRAINT "chk_price_changes_old_price_nonneg" CHECK ("price_changes"."old_price" IS NULL OR "price_changes"."old_price" >= 0),
	CONSTRAINT "chk_price_changes_new_price_nonneg" CHECK ("price_changes"."new_price" >= 0)
);
--> statement-breakpoint
ALTER TABLE "price_changes" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "product_barcodes" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"device_id" uuid NOT NULL,
	"hlc" text NOT NULL,
	"created_at_ms" bigint NOT NULL,
	"updated_at_ms" bigint NOT NULL,
	"deleted_at_ms" bigint,
	"product_id" uuid NOT NULL,
	"variant_id" uuid,
	"barcode" text NOT NULL,
	"format" text NOT NULL,
	CONSTRAINT "chk_product_barcodes_hlc_len" CHECK (length("product_barcodes"."hlc") = 58),
	CONSTRAINT "chk_product_barcodes_barcode_nonempty" CHECK (length(trim("product_barcodes"."barcode")) >= 1),
	CONSTRAINT "chk_product_barcodes_format" CHECK ("product_barcodes"."format" IN ('ean13', 'ean8', 'upca', 'internal', 'other'))
);
--> statement-breakpoint
ALTER TABLE "product_barcodes" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "product_variants" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"device_id" uuid NOT NULL,
	"hlc" text NOT NULL,
	"created_at_ms" bigint NOT NULL,
	"updated_at_ms" bigint NOT NULL,
	"deleted_at_ms" bigint,
	"product_id" uuid NOT NULL,
	"name" text NOT NULL,
	"name_search" text NOT NULL,
	"sku" text,
	"sku_search" text,
	"attributes_json" text NOT NULL,
	"sale_price" bigint,
	CONSTRAINT "chk_product_variants_hlc_len" CHECK (length("product_variants"."hlc") = 58),
	CONSTRAINT "chk_product_variants_name_nonempty" CHECK (length(trim("product_variants"."name")) >= 1),
	CONSTRAINT "chk_product_variants_attrs_json" CHECK (length(trim("product_variants"."attributes_json")) >= 2),
	CONSTRAINT "chk_product_variants_sale_price_nonneg" CHECK ("product_variants"."sale_price" IS NULL OR "product_variants"."sale_price" >= 0)
);
--> statement-breakpoint
ALTER TABLE "product_variants" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "products" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"device_id" uuid NOT NULL,
	"hlc" text NOT NULL,
	"created_at_ms" bigint NOT NULL,
	"updated_at_ms" bigint NOT NULL,
	"deleted_at_ms" bigint,
	"category_id" uuid,
	"sku" text,
	"sku_search" text,
	"name" text NOT NULL,
	"name_search" text NOT NULL,
	"unit" text NOT NULL,
	"unlimited" boolean DEFAULT false NOT NULL,
	"min_stock" bigint,
	"has_variants" boolean DEFAULT false NOT NULL,
	"track_batches" boolean DEFAULT false NOT NULL,
	"sale_price" bigint NOT NULL,
	"mxik" text,
	"package_code" text,
	"vat_rate_bp" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "chk_products_hlc_len" CHECK (length("products"."hlc") = 58),
	CONSTRAINT "chk_products_name_nonempty" CHECK (length(trim("products"."name")) >= 1),
	CONSTRAINT "chk_products_unit" CHECK ("products"."unit" IN ('dona', 'kg', 'g', 'litr', 'metr', 'm2', 'qadoq')),
	CONSTRAINT "chk_products_min_stock_nonneg" CHECK ("products"."min_stock" IS NULL OR "products"."min_stock" >= 0),
	CONSTRAINT "chk_products_min_stock_unit_int" CHECK ("products"."min_stock" IS NULL OR "products"."unit" NOT IN ('dona', 'qadoq') OR ("products"."min_stock" % 1000) = 0),
	CONSTRAINT "chk_products_sale_price_nonneg" CHECK ("products"."sale_price" >= 0),
	CONSTRAINT "chk_products_vat_rate_bp" CHECK ("products"."vat_rate_bp" >= 0 AND "products"."vat_rate_bp" <= 10000)
);
--> statement-breakpoint
ALTER TABLE "products" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "promotions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"device_id" uuid NOT NULL,
	"hlc" text NOT NULL,
	"created_at_ms" bigint NOT NULL,
	"updated_at_ms" bigint NOT NULL,
	"deleted_at_ms" bigint,
	"target_store_id" uuid,
	"name" text NOT NULL,
	"type" text NOT NULL,
	"scope" text NOT NULL,
	"target_product_id" uuid,
	"target_category_id" uuid,
	"discount_percent_bp" integer,
	"discount_amount" bigint,
	"buy_qty" integer,
	"free_qty" integer,
	"starts_at_ms" bigint NOT NULL,
	"ends_at_ms" bigint,
	"is_active" boolean DEFAULT true NOT NULL,
	CONSTRAINT "chk_promotions_hlc_len" CHECK (length("promotions"."hlc") = 58),
	CONSTRAINT "chk_promotions_name_nonempty" CHECK (length(trim("promotions"."name")) >= 1),
	CONSTRAINT "chk_promotions_type" CHECK ("promotions"."type" IN ('percent', 'fixed_amount', 'buy_x_get_y')),
	CONSTRAINT "chk_promotions_scope" CHECK ("promotions"."scope" IN ('product', 'category', 'all')),
	CONSTRAINT "chk_promotions_window" CHECK ("promotions"."ends_at_ms" IS NULL OR "promotions"."ends_at_ms" > "promotions"."starts_at_ms"),
	CONSTRAINT "chk_promotions_scope_targets" CHECK (("promotions"."scope" = 'product' AND "promotions"."target_product_id" IS NOT NULL AND "promotions"."target_category_id" IS NULL) OR ("promotions"."scope" = 'category' AND "promotions"."target_category_id" IS NOT NULL AND "promotions"."target_product_id" IS NULL) OR ("promotions"."scope" = 'all' AND "promotions"."target_product_id" IS NULL AND "promotions"."target_category_id" IS NULL)),
	CONSTRAINT "chk_promotions_type_fields" CHECK (("promotions"."type" = 'percent' AND "promotions"."discount_percent_bp" BETWEEN 1 AND 10000 AND "promotions"."discount_amount" IS NULL AND "promotions"."buy_qty" IS NULL AND "promotions"."free_qty" IS NULL) OR ("promotions"."type" = 'fixed_amount' AND "promotions"."discount_amount" > 0 AND "promotions"."discount_percent_bp" IS NULL AND "promotions"."buy_qty" IS NULL AND "promotions"."free_qty" IS NULL) OR ("promotions"."type" = 'buy_x_get_y' AND "promotions"."buy_qty" >= 1 AND "promotions"."free_qty" >= 1 AND "promotions"."discount_percent_bp" IS NULL AND "promotions"."discount_amount" IS NULL))
);
--> statement-breakpoint
ALTER TABLE "promotions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "receiving_cost_confirmations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"store_id" uuid NOT NULL,
	"device_id" uuid NOT NULL,
	"hlc" text NOT NULL,
	"created_at_ms" bigint NOT NULL,
	"receiving_id" uuid NOT NULL,
	"receiving_line_id" uuid NOT NULL,
	"supplier_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"variant_id" uuid,
	"batch_id" uuid,
	"received_qty" bigint NOT NULL,
	"confirmed_total_cost" bigint NOT NULL,
	"due_days" integer,
	"due_at_ms" bigint,
	"reason" text NOT NULL,
	"confirmed_by_user_id" uuid NOT NULL,
	"client_request_id" uuid NOT NULL,
	"request_hash" text NOT NULL,
	CONSTRAINT "chk_receiving_cost_confirmations_hlc_len" CHECK (length("receiving_cost_confirmations"."hlc") = 58),
	CONSTRAINT "chk_receiving_cost_confirms_qty_pos" CHECK ("receiving_cost_confirmations"."received_qty" > 0),
	CONSTRAINT "chk_receiving_cost_confirms_cost_nonneg" CHECK ("receiving_cost_confirmations"."confirmed_total_cost" >= 0),
	CONSTRAINT "chk_receiving_cost_confirms_reason_nonempty" CHECK (length(trim("receiving_cost_confirmations"."reason")) >= 1),
	CONSTRAINT "chk_receiving_cost_confirms_req_hash_nonempty" CHECK (length(trim("receiving_cost_confirmations"."request_hash")) >= 6)
);
--> statement-breakpoint
ALTER TABLE "receiving_cost_confirmations" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "return_lines" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"store_id" uuid NOT NULL,
	"device_id" uuid NOT NULL,
	"hlc" text NOT NULL,
	"created_at_ms" bigint NOT NULL,
	"return_id" uuid NOT NULL,
	"sale_id" uuid NOT NULL,
	"sale_line_id" uuid NOT NULL,
	"sort_order" integer NOT NULL,
	"line_kind" text NOT NULL,
	"product_id" uuid,
	"variant_id" uuid,
	"item_name" text NOT NULL,
	"unit" text NOT NULL,
	"qty" bigint NOT NULL,
	"unit_price_snapshot" bigint NOT NULL,
	"vat_rate_bp_snapshot" integer NOT NULL,
	"mxik_snapshot" text,
	"package_code_snapshot" text,
	"refund_amount" bigint NOT NULL,
	"net_ex_vat" bigint NOT NULL,
	"vat_total" bigint NOT NULL,
	"cost_value" bigint DEFAULT 0 NOT NULL,
	CONSTRAINT "chk_return_lines_hlc_len" CHECK (length("return_lines"."hlc") = 58),
	CONSTRAINT "chk_return_lines_sort_nonneg" CHECK ("return_lines"."sort_order" >= 0),
	CONSTRAINT "chk_return_lines_kind" CHECK ("return_lines"."line_kind" IN ('catalog', 'quick_sale')),
	CONSTRAINT "chk_return_lines_kind_product" CHECK (("return_lines"."line_kind" = 'catalog' AND "return_lines"."product_id" IS NOT NULL) OR ("return_lines"."line_kind" = 'quick_sale' AND "return_lines"."product_id" IS NULL AND "return_lines"."variant_id" IS NULL)),
	CONSTRAINT "chk_return_lines_name_nonempty" CHECK (length(trim("return_lines"."item_name")) >= 1),
	CONSTRAINT "chk_return_lines_unit" CHECK ("return_lines"."unit" IN ('dona', 'kg', 'g', 'litr', 'metr', 'm2', 'qadoq')),
	CONSTRAINT "chk_return_lines_qty_pos" CHECK ("return_lines"."qty" > 0),
	CONSTRAINT "chk_return_lines_unit_int" CHECK ("return_lines"."unit" NOT IN ('dona', 'qadoq') OR ("return_lines"."qty" % 1000) = 0),
	CONSTRAINT "chk_return_lines_money_nonneg" CHECK ("return_lines"."unit_price_snapshot" >= 0 AND "return_lines"."refund_amount" >= 0 AND "return_lines"."net_ex_vat" >= 0 AND "return_lines"."vat_total" >= 0 AND "return_lines"."cost_value" >= 0),
	CONSTRAINT "chk_return_lines_vat_bp" CHECK ("return_lines"."vat_rate_bp_snapshot" >= 0 AND "return_lines"."vat_rate_bp_snapshot" <= 10000),
	CONSTRAINT "chk_return_lines_arithmetic" CHECK ("return_lines"."net_ex_vat" + "return_lines"."vat_total" = "return_lines"."refund_amount")
);
--> statement-breakpoint
ALTER TABLE "return_lines" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "return_payments" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"store_id" uuid NOT NULL,
	"device_id" uuid NOT NULL,
	"hlc" text NOT NULL,
	"created_at_ms" bigint NOT NULL,
	"return_id" uuid NOT NULL,
	"sale_id" uuid NOT NULL,
	"method" text NOT NULL,
	"amount" bigint NOT NULL,
	"provider_ref" text,
	CONSTRAINT "chk_return_payments_hlc_len" CHECK (length("return_payments"."hlc") = 58),
	CONSTRAINT "chk_return_payments_method" CHECK ("return_payments"."method" IN ('cash', 'card', 'uzqr', 'payme', 'click', 'uzum', 'social_card', 'other')),
	CONSTRAINT "chk_return_payments_pos" CHECK ("return_payments"."amount" > 0),
	CONSTRAINT "chk_return_payments_cash_no_ref" CHECK ("return_payments"."method" <> 'cash' OR "return_payments"."provider_ref" IS NULL)
);
--> statement-breakpoint
ALTER TABLE "return_payments" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "returns" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"store_id" uuid NOT NULL,
	"device_id" uuid NOT NULL,
	"hlc" text NOT NULL,
	"created_at_ms" bigint NOT NULL,
	"sale_id" uuid NOT NULL,
	"shift_id" uuid,
	"shift_cashier_session_id" uuid,
	"return_no" bigint NOT NULL,
	"return_code" text NOT NULL,
	"processed_by_user_id" uuid NOT NULL,
	"override_approved_by_user_id" uuid,
	"override_approved_at_ms" bigint,
	"reason" text NOT NULL,
	"client_request_id" uuid NOT NULL,
	"request_hash" text NOT NULL,
	"total_refund" bigint NOT NULL,
	"total_net_ex_vat" bigint NOT NULL,
	"total_vat" bigint NOT NULL,
	"cash_refund_amount" bigint NOT NULL,
	"non_cash_refund_amount" bigint NOT NULL,
	"debt_offset_amount" bigint DEFAULT 0 NOT NULL,
	CONSTRAINT "chk_returns_hlc_len" CHECK (length("returns"."hlc") = 58),
	CONSTRAINT "chk_returns_return_no_pos" CHECK ("returns"."return_no" >= 1),
	CONSTRAINT "chk_returns_code_nonempty" CHECK (length(trim("returns"."return_code")) >= 1),
	CONSTRAINT "chk_returns_reason_nonempty" CHECK (length(trim("returns"."reason")) >= 1),
	CONSTRAINT "chk_returns_request_hash_nonempty" CHECK (length(trim("returns"."request_hash")) >= 6),
	CONSTRAINT "chk_returns_money_nonneg" CHECK ("returns"."total_refund" >= 0 AND "returns"."total_net_ex_vat" >= 0 AND "returns"."total_vat" >= 0 AND "returns"."cash_refund_amount" >= 0 AND "returns"."non_cash_refund_amount" >= 0 AND "returns"."debt_offset_amount" >= 0),
	CONSTRAINT "chk_returns_totals_balance" CHECK ("returns"."cash_refund_amount" + "returns"."non_cash_refund_amount" + "returns"."debt_offset_amount" = "returns"."total_refund" AND "returns"."total_net_ex_vat" + "returns"."total_vat" = "returns"."total_refund"),
	CONSTRAINT "chk_returns_override_pair" CHECK (("returns"."override_approved_by_user_id" IS NULL AND "returns"."override_approved_at_ms" IS NULL) OR ("returns"."override_approved_by_user_id" IS NOT NULL AND "returns"."override_approved_at_ms" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "returns" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "sale_lines" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"store_id" uuid NOT NULL,
	"device_id" uuid NOT NULL,
	"hlc" text NOT NULL,
	"created_at_ms" bigint NOT NULL,
	"sale_id" uuid NOT NULL,
	"sort_order" integer NOT NULL,
	"line_kind" text NOT NULL,
	"product_id" uuid,
	"variant_id" uuid,
	"category_id_snapshot" uuid,
	"item_name" text NOT NULL,
	"unit" text NOT NULL,
	"qty" bigint NOT NULL,
	"unit_price_snapshot" bigint NOT NULL,
	"applied_promotion_id" uuid,
	"applied_promotion_name" text,
	"free_units" bigint DEFAULT 0 NOT NULL,
	"gross_total" bigint NOT NULL,
	"promo_discount" bigint NOT NULL,
	"subtotal_after_promo" bigint NOT NULL,
	"allocated_order_discount" bigint NOT NULL,
	"final_total" bigint NOT NULL,
	"vat_rate_bp_snapshot" integer NOT NULL,
	"net_ex_vat" bigint NOT NULL,
	"vat_total" bigint NOT NULL,
	"mxik_snapshot" text,
	"package_code_snapshot" text,
	"cost_value" bigint DEFAULT 0 NOT NULL,
	CONSTRAINT "chk_sale_lines_hlc_len" CHECK (length("sale_lines"."hlc") = 58),
	CONSTRAINT "chk_sale_lines_sort_nonneg" CHECK ("sale_lines"."sort_order" >= 0),
	CONSTRAINT "chk_sale_lines_kind" CHECK ("sale_lines"."line_kind" IN ('catalog', 'quick_sale')),
	CONSTRAINT "chk_sale_lines_kind_product" CHECK (("sale_lines"."line_kind" = 'catalog' AND "sale_lines"."product_id" IS NOT NULL) OR ("sale_lines"."line_kind" = 'quick_sale' AND "sale_lines"."product_id" IS NULL AND "sale_lines"."variant_id" IS NULL)),
	CONSTRAINT "chk_sale_lines_name_nonempty" CHECK (length(trim("sale_lines"."item_name")) >= 1),
	CONSTRAINT "chk_sale_lines_unit" CHECK ("sale_lines"."unit" IN ('dona', 'kg', 'g', 'litr', 'metr', 'm2', 'qadoq')),
	CONSTRAINT "chk_sale_lines_qty_pos" CHECK ("sale_lines"."qty" > 0),
	CONSTRAINT "chk_sale_lines_unit_int" CHECK ("sale_lines"."unit" NOT IN ('dona', 'qadoq') OR ("sale_lines"."qty" % 1000) = 0),
	CONSTRAINT "chk_sale_lines_money_nonneg" CHECK ("sale_lines"."unit_price_snapshot" >= 0 AND "sale_lines"."free_units" >= 0 AND "sale_lines"."gross_total" >= 0 AND "sale_lines"."promo_discount" >= 0 AND "sale_lines"."subtotal_after_promo" >= 0 AND "sale_lines"."allocated_order_discount" >= 0 AND "sale_lines"."final_total" >= 0 AND "sale_lines"."net_ex_vat" >= 0 AND "sale_lines"."vat_total" >= 0 AND "sale_lines"."cost_value" >= 0),
	CONSTRAINT "chk_sale_lines_vat_bp" CHECK ("sale_lines"."vat_rate_bp_snapshot" >= 0 AND "sale_lines"."vat_rate_bp_snapshot" <= 10000),
	CONSTRAINT "chk_sale_lines_arithmetic" CHECK ("sale_lines"."subtotal_after_promo" = "sale_lines"."gross_total" - "sale_lines"."promo_discount" AND "sale_lines"."final_total" = "sale_lines"."subtotal_after_promo" - "sale_lines"."allocated_order_discount" AND "sale_lines"."net_ex_vat" + "sale_lines"."vat_total" = "sale_lines"."final_total")
);
--> statement-breakpoint
ALTER TABLE "sale_lines" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "sales" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"store_id" uuid NOT NULL,
	"device_id" uuid NOT NULL,
	"hlc" text NOT NULL,
	"created_at_ms" bigint NOT NULL,
	"updated_at_ms" bigint NOT NULL,
	"receipt_no" bigint NOT NULL,
	"receipt_code" text NOT NULL,
	"source_cart_id" uuid,
	"source_order_id" uuid,
	"cashier_user_id" uuid NOT NULL,
	"completed_by_user_id" uuid NOT NULL,
	"customer_id" uuid,
	"shift_id" uuid,
	"shift_cashier_session_id" uuid,
	"client_request_id" uuid NOT NULL,
	"request_hash" text NOT NULL,
	"subtotal_gross" bigint NOT NULL,
	"total_promo_discount" bigint NOT NULL,
	"subtotal_after_promo" bigint NOT NULL,
	"manual_discount_mode" text NOT NULL,
	"manual_discount_value" bigint NOT NULL,
	"manual_discount_reason" text,
	"order_discount_amount" bigint NOT NULL,
	"total_final" bigint NOT NULL,
	"total_net_ex_vat" bigint NOT NULL,
	"total_vat" bigint NOT NULL,
	"total_paid" bigint NOT NULL,
	"debt_amount" bigint DEFAULT 0 NOT NULL,
	"change_amount" bigint NOT NULL,
	"override_approved_by_user_id" uuid,
	"override_approved_amount" bigint,
	"override_approved_at_ms" bigint,
	"voided_at_ms" bigint,
	"voided_by_user_id" uuid,
	"void_reason" text,
	"void_client_request_id" uuid,
	"void_request_hash" text,
	CONSTRAINT "chk_sales_hlc_len" CHECK (length("sales"."hlc") = 58),
	CONSTRAINT "chk_sales_receipt_no_pos" CHECK ("sales"."receipt_no" >= 1),
	CONSTRAINT "chk_sales_receipt_code_nonempty" CHECK (length(trim("sales"."receipt_code")) >= 1),
	CONSTRAINT "chk_sales_request_hash_nonempty" CHECK (length(trim("sales"."request_hash")) >= 6),
	CONSTRAINT "chk_sales_disc_mode" CHECK ("sales"."manual_discount_mode" IN ('none', 'percent', 'amount')),
	CONSTRAINT "chk_sales_disc_val" CHECK (("sales"."manual_discount_mode" = 'none' AND "sales"."manual_discount_value" = 0) OR ("sales"."manual_discount_mode" = 'percent' AND "sales"."manual_discount_value" BETWEEN 1 AND 10000) OR ("sales"."manual_discount_mode" = 'amount' AND "sales"."manual_discount_value" > 0)),
	CONSTRAINT "chk_sales_money_nonneg" CHECK ("sales"."subtotal_gross" >= 0 AND "sales"."total_promo_discount" >= 0 AND "sales"."subtotal_after_promo" >= 0 AND "sales"."order_discount_amount" >= 0 AND "sales"."total_final" >= 0 AND "sales"."total_net_ex_vat" >= 0 AND "sales"."total_vat" >= 0 AND "sales"."total_paid" >= 0 AND "sales"."debt_amount" >= 0 AND "sales"."change_amount" >= 0),
	CONSTRAINT "chk_sales_totals_balance" CHECK ("sales"."total_paid" + "sales"."debt_amount" = "sales"."total_final" AND "sales"."total_net_ex_vat" + "sales"."total_vat" = "sales"."total_final"),
	CONSTRAINT "chk_sales_override_pair" CHECK (("sales"."override_approved_by_user_id" IS NULL AND "sales"."override_approved_amount" IS NULL AND "sales"."override_approved_at_ms" IS NULL) OR ("sales"."override_approved_by_user_id" IS NOT NULL AND "sales"."override_approved_amount" >= 0 AND "sales"."override_approved_at_ms" IS NOT NULL)),
	CONSTRAINT "chk_sales_void_pair" CHECK (("sales"."voided_at_ms" IS NULL AND "sales"."voided_by_user_id" IS NULL AND "sales"."void_reason" IS NULL AND "sales"."void_client_request_id" IS NULL AND "sales"."void_request_hash" IS NULL) OR ("sales"."voided_at_ms" IS NOT NULL AND "sales"."voided_by_user_id" IS NOT NULL AND "sales"."void_reason" IS NOT NULL AND length(trim("sales"."void_reason")) >= 1 AND "sales"."void_client_request_id" IS NOT NULL AND "sales"."void_request_hash" IS NOT NULL AND length(trim("sales"."void_request_hash")) >= 6))
);
--> statement-breakpoint
ALTER TABLE "sales" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "shift_cashier_sessions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"store_id" uuid NOT NULL,
	"device_id" uuid NOT NULL,
	"hlc" text NOT NULL,
	"created_at_ms" bigint NOT NULL,
	"updated_at_ms" bigint NOT NULL,
	"shift_id" uuid NOT NULL,
	"session_seq" integer NOT NULL,
	"cashier_user_id" uuid NOT NULL,
	"status" text NOT NULL,
	"opening_float" bigint NOT NULL,
	"expected_cash" bigint,
	"counted_cash" bigint,
	"discrepancy" bigint,
	"discrepancy_reason" text,
	"denominations_json" text,
	"override_approved_by_user_id" uuid,
	"handed_off_by_user_id" uuid,
	"note" text,
	"started_at_ms" bigint NOT NULL,
	"ended_at_ms" bigint,
	"handoff_client_request_id" uuid,
	"handoff_request_hash" text,
	CONSTRAINT "chk_shift_cashier_sessions_hlc_len" CHECK (length("shift_cashier_sessions"."hlc") = 58),
	CONSTRAINT "chk_shift_cashier_seq_pos" CHECK ("shift_cashier_sessions"."session_seq" >= 1),
	CONSTRAINT "chk_shift_cashier_status" CHECK ("shift_cashier_sessions"."status" IN ('active', 'closed')),
	CONSTRAINT "chk_shift_cashier_float_nonneg" CHECK ("shift_cashier_sessions"."opening_float" >= 0),
	CONSTRAINT "chk_shift_cashier_closed_fields" CHECK (("shift_cashier_sessions"."status" = 'active' AND "shift_cashier_sessions"."expected_cash" IS NULL AND "shift_cashier_sessions"."counted_cash" IS NULL AND "shift_cashier_sessions"."discrepancy" IS NULL AND "shift_cashier_sessions"."ended_at_ms" IS NULL) OR ("shift_cashier_sessions"."status" = 'closed' AND "shift_cashier_sessions"."expected_cash" IS NOT NULL AND "shift_cashier_sessions"."counted_cash" IS NOT NULL AND "shift_cashier_sessions"."counted_cash" >= 0 AND "shift_cashier_sessions"."discrepancy" IS NOT NULL AND "shift_cashier_sessions"."ended_at_ms" IS NOT NULL AND "shift_cashier_sessions"."ended_at_ms" >= "shift_cashier_sessions"."started_at_ms")),
	CONSTRAINT "chk_shift_cashier_handoff_req_pair" CHECK (("shift_cashier_sessions"."handoff_client_request_id" IS NULL AND "shift_cashier_sessions"."handoff_request_hash" IS NULL) OR ("shift_cashier_sessions"."handoff_client_request_id" IS NOT NULL AND "shift_cashier_sessions"."handoff_request_hash" IS NOT NULL AND length(trim("shift_cashier_sessions"."handoff_request_hash")) >= 6))
);
--> statement-breakpoint
ALTER TABLE "shift_cashier_sessions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "shift_closure_cashiers" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"store_id" uuid NOT NULL,
	"device_id" uuid NOT NULL,
	"hlc" text NOT NULL,
	"created_at_ms" bigint NOT NULL,
	"shift_closure_id" uuid NOT NULL,
	"session_id" uuid NOT NULL,
	"cashier_user_id" uuid NOT NULL,
	"session_seq" integer NOT NULL,
	"opening_float" bigint NOT NULL,
	"expected_cash" bigint NOT NULL,
	"counted_cash" bigint NOT NULL,
	"discrepancy" bigint NOT NULL,
	"sales_count" integer NOT NULL,
	"returns_count" integer NOT NULL,
	"sales_total" bigint NOT NULL,
	"returns_total" bigint NOT NULL,
	"cash_in_total" bigint NOT NULL,
	"cash_out_total" bigint NOT NULL,
	CONSTRAINT "chk_shift_closure_cashiers_hlc_len" CHECK (length("shift_closure_cashiers"."hlc") = 58),
	CONSTRAINT "chk_shift_closure_cashiers_nonneg" CHECK ("shift_closure_cashiers"."session_seq" >= 1 AND "shift_closure_cashiers"."opening_float" >= 0 AND "shift_closure_cashiers"."counted_cash" >= 0 AND "shift_closure_cashiers"."sales_count" >= 0 AND "shift_closure_cashiers"."returns_count" >= 0 AND "shift_closure_cashiers"."sales_total" >= 0 AND "shift_closure_cashiers"."returns_total" >= 0 AND "shift_closure_cashiers"."cash_in_total" >= 0 AND "shift_closure_cashiers"."cash_out_total" >= 0)
);
--> statement-breakpoint
ALTER TABLE "shift_closure_cashiers" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "shift_closure_method_totals" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"store_id" uuid NOT NULL,
	"device_id" uuid NOT NULL,
	"hlc" text NOT NULL,
	"created_at_ms" bigint NOT NULL,
	"shift_closure_id" uuid NOT NULL,
	"method" text NOT NULL,
	"sales_amount" bigint NOT NULL,
	"returns_amount" bigint NOT NULL,
	"net_amount" bigint NOT NULL,
	CONSTRAINT "chk_shift_closure_method_totals_hlc_len" CHECK (length("shift_closure_method_totals"."hlc") = 58),
	CONSTRAINT "chk_shift_closure_methods_enum" CHECK ("shift_closure_method_totals"."method" IN ('cash', 'card', 'uzqr', 'payme', 'click', 'uzum', 'social_card', 'other', 'advance', 'debt')),
	CONSTRAINT "chk_shift_closure_methods_nonneg" CHECK ("shift_closure_method_totals"."sales_amount" >= 0 AND "shift_closure_method_totals"."returns_amount" >= 0)
);
--> statement-breakpoint
ALTER TABLE "shift_closure_method_totals" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "shift_closures" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"store_id" uuid NOT NULL,
	"device_id" uuid NOT NULL,
	"hlc" text NOT NULL,
	"created_at_ms" bigint NOT NULL,
	"shift_id" uuid NOT NULL,
	"closure_seq" integer NOT NULL,
	"is_reclose" boolean DEFAULT false NOT NULL,
	"reason" text,
	"closed_by_user_id" uuid NOT NULL,
	"override_approved_by_user_id" uuid,
	"client_request_id" uuid NOT NULL,
	"request_hash" text NOT NULL,
	"expected_cash" bigint NOT NULL,
	"counted_cash" bigint NOT NULL,
	"discrepancy" bigint NOT NULL,
	"denominations_json" text,
	"sales_count" integer NOT NULL,
	"returns_count" integer NOT NULL,
	"voids_count" integer NOT NULL,
	"gross_sales_total" bigint NOT NULL,
	"returns_total" bigint NOT NULL,
	"net_sales_total" bigint NOT NULL,
	"order_advance_cash_total" bigint DEFAULT 0 NOT NULL,
	"order_advance_non_cash_total" bigint DEFAULT 0 NOT NULL,
	"order_advance_refund_total" bigint DEFAULT 0 NOT NULL,
	CONSTRAINT "chk_shift_closures_hlc_len" CHECK (length("shift_closures"."hlc") = 58),
	CONSTRAINT "chk_shift_closures_seq_pos" CHECK ("shift_closures"."closure_seq" >= 1),
	CONSTRAINT "chk_shift_closures_reclose_reason" CHECK ("shift_closures"."is_reclose" = false OR ("shift_closures"."reason" IS NOT NULL AND length(trim("shift_closures"."reason")) >= 1)),
	CONSTRAINT "chk_shift_closures_req_hash" CHECK (length(trim("shift_closures"."request_hash")) >= 6),
	CONSTRAINT "chk_shift_closures_money_nonneg" CHECK ("shift_closures"."counted_cash" >= 0 AND "shift_closures"."gross_sales_total" >= 0 AND "shift_closures"."returns_total" >= 0 AND "shift_closures"."order_advance_cash_total" >= 0 AND "shift_closures"."order_advance_non_cash_total" >= 0 AND "shift_closures"."order_advance_refund_total" >= 0),
	CONSTRAINT "chk_shift_closures_counts_nonneg" CHECK ("shift_closures"."sales_count" >= 0 AND "shift_closures"."returns_count" >= 0 AND "shift_closures"."voids_count" >= 0)
);
--> statement-breakpoint
ALTER TABLE "shift_closures" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "shifts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"store_id" uuid NOT NULL,
	"device_id" uuid NOT NULL,
	"hlc" text NOT NULL,
	"created_at_ms" bigint NOT NULL,
	"updated_at_ms" bigint NOT NULL,
	"shift_no" bigint NOT NULL,
	"shift_code" text NOT NULL,
	"status" text NOT NULL,
	"opened_by_user_id" uuid NOT NULL,
	"closed_by_user_id" uuid,
	"opening_cash" bigint NOT NULL,
	"previous_close_cash" bigint,
	"opening_discrepancy" bigint DEFAULT 0 NOT NULL,
	"opening_discrepancy_reason" text,
	"opening_note" text,
	"closing_note" text,
	"opened_at_ms" bigint NOT NULL,
	"closed_at_ms" bigint,
	"open_client_request_id" uuid NOT NULL,
	"open_request_hash" text NOT NULL,
	"close_client_request_id" uuid,
	"close_request_hash" text,
	CONSTRAINT "chk_shifts_hlc_len" CHECK (length("shifts"."hlc") = 58),
	CONSTRAINT "chk_shifts_no_pos" CHECK ("shifts"."shift_no" >= 1),
	CONSTRAINT "chk_shifts_code_nonempty" CHECK (length(trim("shifts"."shift_code")) >= 1),
	CONSTRAINT "chk_shifts_status" CHECK ("shifts"."status" IN ('open', 'closed')),
	CONSTRAINT "chk_shifts_opening_nonneg" CHECK ("shifts"."opening_cash" >= 0 AND ("shifts"."previous_close_cash" IS NULL OR "shifts"."previous_close_cash" >= 0)),
	CONSTRAINT "chk_shifts_open_req_hash" CHECK (length(trim("shifts"."open_request_hash")) >= 6),
	CONSTRAINT "chk_shifts_open_closed_pair" CHECK (("shifts"."status" = 'open' AND "shifts"."closed_at_ms" IS NULL AND "shifts"."closed_by_user_id" IS NULL AND "shifts"."close_client_request_id" IS NULL AND "shifts"."close_request_hash" IS NULL) OR ("shifts"."status" = 'closed' AND "shifts"."closed_at_ms" IS NOT NULL AND "shifts"."closed_by_user_id" IS NOT NULL AND "shifts"."close_client_request_id" IS NOT NULL AND "shifts"."close_request_hash" IS NOT NULL AND length(trim("shifts"."close_request_hash")) >= 6 AND "shifts"."closed_at_ms" >= "shifts"."opened_at_ms"))
);
--> statement-breakpoint
ALTER TABLE "shifts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "stock_moves" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"store_id" uuid NOT NULL,
	"device_id" uuid NOT NULL,
	"hlc" text NOT NULL,
	"created_at_ms" bigint NOT NULL,
	"product_id" uuid NOT NULL,
	"variant_id" uuid,
	"batch_id" uuid,
	"qty_delta" bigint NOT NULL,
	"cost_value_delta" bigint NOT NULL,
	"reason" text NOT NULL,
	"source_type" text NOT NULL,
	"source_id" uuid NOT NULL,
	"created_by_user_id" uuid NOT NULL,
	"note" text,
	CONSTRAINT "chk_stock_moves_hlc_len" CHECK (length("stock_moves"."hlc") = 58),
	CONSTRAINT "chk_stock_moves_qty_nonzero" CHECK ("stock_moves"."qty_delta" <> 0),
	CONSTRAINT "chk_stock_moves_sign_match" CHECK (("stock_moves"."qty_delta" > 0 AND "stock_moves"."cost_value_delta" >= 0) OR ("stock_moves"."qty_delta" < 0 AND "stock_moves"."cost_value_delta" <= 0)),
	CONSTRAINT "chk_stock_moves_reason" CHECK ("stock_moves"."reason" IN ('initial', 'purchase', 'sale', 'return', 'supplier_return', 'inventory', 'adjustment', 'damaged', 'broken', 'personal', 'lost')),
	CONSTRAINT "chk_stock_moves_source_type" CHECK ("stock_moves"."source_type" IN ('stock_entry', 'inventory_count', 'sale', 'return', 'purchase', 'supplier_return', 'adjustment'))
);
--> statement-breakpoint
ALTER TABLE "stock_moves" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "supplier_ledger" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"store_id" uuid NOT NULL,
	"device_id" uuid NOT NULL,
	"hlc" text NOT NULL,
	"created_at_ms" bigint NOT NULL,
	"supplier_id" uuid NOT NULL,
	"entry_type" text NOT NULL,
	"amount_delta" bigint NOT NULL,
	"source_type" text NOT NULL,
	"source_id" uuid NOT NULL,
	"receiving_id" uuid,
	"supplier_return_id" uuid,
	"payment_method" text,
	"provider_ref" text,
	"cash_move_id" uuid,
	"due_at_ms" bigint,
	"reason" text,
	"created_by_user_id" uuid NOT NULL,
	"client_request_id" uuid,
	"request_hash" text,
	CONSTRAINT "chk_supplier_ledger_hlc_len" CHECK (length("supplier_ledger"."hlc") = 58),
	CONSTRAINT "chk_supplier_ledger_entry_type" CHECK ("supplier_ledger"."entry_type" IN ('opening_balance', 'receiving_debt', 'supplier_payment', 'supplier_return', 'adjustment')),
	CONSTRAINT "chk_supplier_ledger_source_type" CHECK ("supplier_ledger"."source_type" IN ('opening_balance', 'receiving', 'receiving_cost_confirm', 'supplier_payment', 'supplier_return', 'adjustment')),
	CONSTRAINT "chk_supplier_ledger_delta_sign" CHECK (("supplier_ledger"."entry_type" IN ('opening_balance', 'receiving_debt') AND "supplier_ledger"."amount_delta" > 0) OR ("supplier_ledger"."entry_type" IN ('supplier_payment', 'supplier_return') AND "supplier_ledger"."amount_delta" < 0) OR ("supplier_ledger"."entry_type" = 'adjustment' AND "supplier_ledger"."amount_delta" <> 0)),
	CONSTRAINT "chk_supplier_ledger_payment_fields" CHECK (("supplier_ledger"."entry_type" = 'supplier_payment' AND "supplier_ledger"."payment_method" IN ('cash', 'card', 'uzqr', 'payme', 'click', 'uzum', 'other') AND (("supplier_ledger"."payment_method" = 'cash' AND "supplier_ledger"."cash_move_id" IS NOT NULL AND "supplier_ledger"."provider_ref" IS NULL) OR ("supplier_ledger"."payment_method" <> 'cash' AND "supplier_ledger"."cash_move_id" IS NULL))) OR ("supplier_ledger"."entry_type" <> 'supplier_payment' AND "supplier_ledger"."payment_method" IS NULL AND "supplier_ledger"."provider_ref" IS NULL AND "supplier_ledger"."cash_move_id" IS NULL)),
	CONSTRAINT "chk_supplier_ledger_ref_consistency" CHECK (("supplier_ledger"."entry_type" = 'receiving_debt' AND "supplier_ledger"."receiving_id" IS NOT NULL) OR ("supplier_ledger"."entry_type" = 'supplier_return' AND "supplier_ledger"."supplier_return_id" IS NOT NULL) OR ("supplier_ledger"."entry_type" IN ('opening_balance', 'supplier_payment', 'adjustment'))),
	CONSTRAINT "chk_supplier_ledger_reason_req" CHECK ("supplier_ledger"."entry_type" NOT IN ('opening_balance', 'adjustment') OR ("supplier_ledger"."reason" IS NOT NULL AND length(trim("supplier_ledger"."reason")) >= 1)),
	CONSTRAINT "chk_supplier_ledger_req_pair" CHECK (("supplier_ledger"."client_request_id" IS NULL AND "supplier_ledger"."request_hash" IS NULL) OR ("supplier_ledger"."client_request_id" IS NOT NULL AND "supplier_ledger"."request_hash" IS NOT NULL AND length(trim("supplier_ledger"."request_hash")) >= 6))
);
--> statement-breakpoint
ALTER TABLE "supplier_ledger" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "supplier_return_lines" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"store_id" uuid NOT NULL,
	"device_id" uuid NOT NULL,
	"hlc" text NOT NULL,
	"created_at_ms" bigint NOT NULL,
	"supplier_return_id" uuid NOT NULL,
	"receiving_line_id" uuid NOT NULL,
	"sort_order" integer NOT NULL,
	"product_id" uuid NOT NULL,
	"variant_id" uuid,
	"batch_id" uuid,
	"stock_move_id" uuid NOT NULL,
	"qty" bigint NOT NULL,
	"return_cost_value" bigint NOT NULL,
	CONSTRAINT "chk_supplier_return_lines_hlc_len" CHECK (length("supplier_return_lines"."hlc") = 58),
	CONSTRAINT "chk_supplier_return_lines_sort_nonneg" CHECK ("supplier_return_lines"."sort_order" >= 0),
	CONSTRAINT "chk_supplier_return_lines_qty_pos" CHECK ("supplier_return_lines"."qty" > 0),
	CONSTRAINT "chk_supplier_return_lines_cost_nonneg" CHECK ("supplier_return_lines"."return_cost_value" >= 0)
);
--> statement-breakpoint
ALTER TABLE "supplier_return_lines" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "supplier_returns" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"store_id" uuid NOT NULL,
	"device_id" uuid NOT NULL,
	"hlc" text NOT NULL,
	"created_at_ms" bigint NOT NULL,
	"return_no" bigint NOT NULL,
	"return_code" text NOT NULL,
	"receiving_id" uuid NOT NULL,
	"supplier_id" uuid NOT NULL,
	"reason" text NOT NULL,
	"total_return_cost" bigint NOT NULL,
	"created_by_user_id" uuid NOT NULL,
	"client_request_id" uuid NOT NULL,
	"request_hash" text NOT NULL,
	CONSTRAINT "chk_supplier_returns_hlc_len" CHECK (length("supplier_returns"."hlc") = 58),
	CONSTRAINT "chk_supplier_returns_no_pos" CHECK ("supplier_returns"."return_no" >= 1),
	CONSTRAINT "chk_supplier_returns_code_nonempty" CHECK (length(trim("supplier_returns"."return_code")) >= 1),
	CONSTRAINT "chk_supplier_returns_reason_nonempty" CHECK (length(trim("supplier_returns"."reason")) >= 1),
	CONSTRAINT "chk_supplier_returns_cost_nonneg" CHECK ("supplier_returns"."total_return_cost" >= 0),
	CONSTRAINT "chk_supplier_returns_req_hash_nonempty" CHECK (length(trim("supplier_returns"."request_hash")) >= 6)
);
--> statement-breakpoint
ALTER TABLE "supplier_returns" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "suppliers" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"device_id" uuid NOT NULL,
	"hlc" text NOT NULL,
	"created_at_ms" bigint NOT NULL,
	"updated_at_ms" bigint NOT NULL,
	"deleted_at_ms" bigint,
	"name" text NOT NULL,
	"name_search" text NOT NULL,
	"tin" text,
	"phone_normalized" text,
	"phone_digits" text,
	"contact_person" text,
	"note" text,
	"default_due_days" integer,
	"is_active" boolean DEFAULT true NOT NULL,
	CONSTRAINT "chk_suppliers_hlc_len" CHECK (length("suppliers"."hlc") = 58),
	CONSTRAINT "chk_suppliers_name_nonempty" CHECK (length(trim("suppliers"."name")) >= 1),
	CONSTRAINT "chk_suppliers_tin_len" CHECK ("suppliers"."tin" IS NULL OR length("suppliers"."tin") = 9),
	CONSTRAINT "chk_suppliers_due_days" CHECK ("suppliers"."default_due_days" IS NULL OR ("suppliers"."default_due_days" >= 1 AND "suppliers"."default_due_days" <= 3650))
);
--> statement-breakpoint
ALTER TABLE "suppliers" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"device_id" uuid NOT NULL,
	"hlc" text NOT NULL,
	"created_at_ms" bigint NOT NULL,
	"updated_at_ms" bigint NOT NULL,
	"deleted_at_ms" bigint,
	"username" text NOT NULL,
	"full_name" text NOT NULL,
	"role" text NOT NULL,
	"is_active" boolean NOT NULL,
	CONSTRAINT "chk_users_hlc_len" CHECK (length("users"."hlc") = 58),
	CONSTRAINT "chk_users_role" CHECK ("users"."role" IN ('owner', 'manager', 'cashier')),
	CONSTRAINT "chk_users_username_nonempty" CHECK (length(trim("users"."username")) >= 2),
	CONSTRAINT "chk_users_full_name_nonempty" CHECK (length(trim("users"."full_name")) >= 1)
);
--> statement-breakpoint
ALTER TABLE "users" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "batches" ADD CONSTRAINT "batches_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "batches" ADD CONSTRAINT "batches_variant_id_product_variants_id_fk" FOREIGN KEY ("variant_id") REFERENCES "public"."product_variants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cash_moves" ADD CONSTRAINT "cash_moves_payment_id_payments_id_fk" FOREIGN KEY ("payment_id") REFERENCES "public"."payments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cash_moves" ADD CONSTRAINT "cash_moves_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "categories" ADD CONSTRAINT "categories_parent_id_categories_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."categories"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_ledger" ADD CONSTRAINT "customer_ledger_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_ledger" ADD CONSTRAINT "customer_ledger_sale_id_sales_id_fk" FOREIGN KEY ("sale_id") REFERENCES "public"."sales"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_ledger" ADD CONSTRAINT "customer_ledger_cash_move_id_cash_moves_id_fk" FOREIGN KEY ("cash_move_id") REFERENCES "public"."cash_moves"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_ledger" ADD CONSTRAINT "customer_ledger_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_ledger" ADD CONSTRAINT "customer_ledger_override_approved_by_user_id_users_id_fk" FOREIGN KEY ("override_approved_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "day_closes" ADD CONSTRAINT "day_closes_closed_by_user_id_users_id_fk" FOREIGN KEY ("closed_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goods_receiving_lines" ADD CONSTRAINT "goods_receiving_lines_receiving_id_goods_receivings_id_fk" FOREIGN KEY ("receiving_id") REFERENCES "public"."goods_receivings"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goods_receiving_lines" ADD CONSTRAINT "goods_receiving_lines_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goods_receiving_lines" ADD CONSTRAINT "goods_receiving_lines_variant_id_product_variants_id_fk" FOREIGN KEY ("variant_id") REFERENCES "public"."product_variants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goods_receiving_lines" ADD CONSTRAINT "goods_receiving_lines_stock_move_id_stock_moves_id_fk" FOREIGN KEY ("stock_move_id") REFERENCES "public"."stock_moves"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goods_receiving_lines" ADD CONSTRAINT "goods_receiving_lines_batch_id_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."batches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goods_receivings" ADD CONSTRAINT "goods_receivings_supplier_id_suppliers_id_fk" FOREIGN KEY ("supplier_id") REFERENCES "public"."suppliers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goods_receivings" ADD CONSTRAINT "goods_receivings_posted_by_user_id_users_id_fk" FOREIGN KEY ("posted_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_count_lines" ADD CONSTRAINT "inventory_count_lines_count_id_inventory_counts_id_fk" FOREIGN KEY ("count_id") REFERENCES "public"."inventory_counts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_count_lines" ADD CONSTRAINT "inventory_count_lines_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_count_lines" ADD CONSTRAINT "inventory_count_lines_variant_id_product_variants_id_fk" FOREIGN KEY ("variant_id") REFERENCES "public"."product_variants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_counts" ADD CONSTRAINT "inventory_counts_started_by_user_id_users_id_fk" FOREIGN KEY ("started_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_counts" ADD CONSTRAINT "inventory_counts_finalized_by_user_id_users_id_fk" FOREIGN KEY ("finalized_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_lines" ADD CONSTRAINT "order_lines_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_lines" ADD CONSTRAINT "order_lines_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_lines" ADD CONSTRAINT "order_lines_variant_id_product_variants_id_fk" FOREIGN KEY ("variant_id") REFERENCES "public"."product_variants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_payments" ADD CONSTRAINT "order_payments_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_payments" ADD CONSTRAINT "order_payments_shift_id_shifts_id_fk" FOREIGN KEY ("shift_id") REFERENCES "public"."shifts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_payments" ADD CONSTRAINT "order_payments_shift_cashier_session_id_shift_cashier_sessions_id_fk" FOREIGN KEY ("shift_cashier_session_id") REFERENCES "public"."shift_cashier_sessions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_payments" ADD CONSTRAINT "order_payments_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_payments" ADD CONSTRAINT "order_payments_override_approved_by_user_id_users_id_fk" FOREIGN KEY ("override_approved_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_override_approved_by_user_id_users_id_fk" FOREIGN KEY ("override_approved_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_delivered_sale_id_sales_id_fk" FOREIGN KEY ("delivered_sale_id") REFERENCES "public"."sales"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_cancelled_by_user_id_users_id_fk" FOREIGN KEY ("cancelled_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_sale_id_sales_id_fk" FOREIGN KEY ("sale_id") REFERENCES "public"."sales"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "price_changes" ADD CONSTRAINT "price_changes_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "price_changes" ADD CONSTRAINT "price_changes_variant_id_product_variants_id_fk" FOREIGN KEY ("variant_id") REFERENCES "public"."product_variants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "price_changes" ADD CONSTRAINT "price_changes_changed_by_user_id_users_id_fk" FOREIGN KEY ("changed_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_barcodes" ADD CONSTRAINT "product_barcodes_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_barcodes" ADD CONSTRAINT "product_barcodes_variant_id_product_variants_id_fk" FOREIGN KEY ("variant_id") REFERENCES "public"."product_variants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_variants" ADD CONSTRAINT "product_variants_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_category_id_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."categories"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "promotions" ADD CONSTRAINT "promotions_target_product_id_products_id_fk" FOREIGN KEY ("target_product_id") REFERENCES "public"."products"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "promotions" ADD CONSTRAINT "promotions_target_category_id_categories_id_fk" FOREIGN KEY ("target_category_id") REFERENCES "public"."categories"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "receiving_cost_confirmations" ADD CONSTRAINT "receiving_cost_confirmations_receiving_id_goods_receivings_id_fk" FOREIGN KEY ("receiving_id") REFERENCES "public"."goods_receivings"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "receiving_cost_confirmations" ADD CONSTRAINT "receiving_cost_confirmations_receiving_line_id_goods_receiving_lines_id_fk" FOREIGN KEY ("receiving_line_id") REFERENCES "public"."goods_receiving_lines"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "receiving_cost_confirmations" ADD CONSTRAINT "receiving_cost_confirmations_supplier_id_suppliers_id_fk" FOREIGN KEY ("supplier_id") REFERENCES "public"."suppliers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "receiving_cost_confirmations" ADD CONSTRAINT "receiving_cost_confirmations_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "receiving_cost_confirmations" ADD CONSTRAINT "receiving_cost_confirmations_variant_id_product_variants_id_fk" FOREIGN KEY ("variant_id") REFERENCES "public"."product_variants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "receiving_cost_confirmations" ADD CONSTRAINT "receiving_cost_confirmations_batch_id_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."batches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "receiving_cost_confirmations" ADD CONSTRAINT "receiving_cost_confirmations_confirmed_by_user_id_users_id_fk" FOREIGN KEY ("confirmed_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "return_lines" ADD CONSTRAINT "return_lines_return_id_returns_id_fk" FOREIGN KEY ("return_id") REFERENCES "public"."returns"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "return_lines" ADD CONSTRAINT "return_lines_sale_id_sales_id_fk" FOREIGN KEY ("sale_id") REFERENCES "public"."sales"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "return_lines" ADD CONSTRAINT "return_lines_sale_line_id_sale_lines_id_fk" FOREIGN KEY ("sale_line_id") REFERENCES "public"."sale_lines"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "return_lines" ADD CONSTRAINT "return_lines_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "return_lines" ADD CONSTRAINT "return_lines_variant_id_product_variants_id_fk" FOREIGN KEY ("variant_id") REFERENCES "public"."product_variants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "return_payments" ADD CONSTRAINT "return_payments_return_id_returns_id_fk" FOREIGN KEY ("return_id") REFERENCES "public"."returns"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "return_payments" ADD CONSTRAINT "return_payments_sale_id_sales_id_fk" FOREIGN KEY ("sale_id") REFERENCES "public"."sales"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "returns" ADD CONSTRAINT "returns_sale_id_sales_id_fk" FOREIGN KEY ("sale_id") REFERENCES "public"."sales"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "returns" ADD CONSTRAINT "returns_processed_by_user_id_users_id_fk" FOREIGN KEY ("processed_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "returns" ADD CONSTRAINT "returns_override_approved_by_user_id_users_id_fk" FOREIGN KEY ("override_approved_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sale_lines" ADD CONSTRAINT "sale_lines_sale_id_sales_id_fk" FOREIGN KEY ("sale_id") REFERENCES "public"."sales"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sale_lines" ADD CONSTRAINT "sale_lines_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sale_lines" ADD CONSTRAINT "sale_lines_variant_id_product_variants_id_fk" FOREIGN KEY ("variant_id") REFERENCES "public"."product_variants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales" ADD CONSTRAINT "sales_cashier_user_id_users_id_fk" FOREIGN KEY ("cashier_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales" ADD CONSTRAINT "sales_completed_by_user_id_users_id_fk" FOREIGN KEY ("completed_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales" ADD CONSTRAINT "sales_override_approved_by_user_id_users_id_fk" FOREIGN KEY ("override_approved_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales" ADD CONSTRAINT "sales_voided_by_user_id_users_id_fk" FOREIGN KEY ("voided_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shift_cashier_sessions" ADD CONSTRAINT "shift_cashier_sessions_shift_id_shifts_id_fk" FOREIGN KEY ("shift_id") REFERENCES "public"."shifts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shift_cashier_sessions" ADD CONSTRAINT "shift_cashier_sessions_cashier_user_id_users_id_fk" FOREIGN KEY ("cashier_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shift_cashier_sessions" ADD CONSTRAINT "shift_cashier_sessions_override_approved_by_user_id_users_id_fk" FOREIGN KEY ("override_approved_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shift_cashier_sessions" ADD CONSTRAINT "shift_cashier_sessions_handed_off_by_user_id_users_id_fk" FOREIGN KEY ("handed_off_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shift_closure_cashiers" ADD CONSTRAINT "shift_closure_cashiers_shift_closure_id_shift_closures_id_fk" FOREIGN KEY ("shift_closure_id") REFERENCES "public"."shift_closures"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shift_closure_cashiers" ADD CONSTRAINT "shift_closure_cashiers_session_id_shift_cashier_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."shift_cashier_sessions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shift_closure_cashiers" ADD CONSTRAINT "shift_closure_cashiers_cashier_user_id_users_id_fk" FOREIGN KEY ("cashier_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shift_closure_method_totals" ADD CONSTRAINT "shift_closure_method_totals_shift_closure_id_shift_closures_id_fk" FOREIGN KEY ("shift_closure_id") REFERENCES "public"."shift_closures"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shift_closures" ADD CONSTRAINT "shift_closures_shift_id_shifts_id_fk" FOREIGN KEY ("shift_id") REFERENCES "public"."shifts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shift_closures" ADD CONSTRAINT "shift_closures_closed_by_user_id_users_id_fk" FOREIGN KEY ("closed_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shift_closures" ADD CONSTRAINT "shift_closures_override_approved_by_user_id_users_id_fk" FOREIGN KEY ("override_approved_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shifts" ADD CONSTRAINT "shifts_opened_by_user_id_users_id_fk" FOREIGN KEY ("opened_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shifts" ADD CONSTRAINT "shifts_closed_by_user_id_users_id_fk" FOREIGN KEY ("closed_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_moves" ADD CONSTRAINT "stock_moves_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_moves" ADD CONSTRAINT "stock_moves_variant_id_product_variants_id_fk" FOREIGN KEY ("variant_id") REFERENCES "public"."product_variants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_moves" ADD CONSTRAINT "stock_moves_batch_id_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."batches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_moves" ADD CONSTRAINT "stock_moves_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_ledger" ADD CONSTRAINT "supplier_ledger_supplier_id_suppliers_id_fk" FOREIGN KEY ("supplier_id") REFERENCES "public"."suppliers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_ledger" ADD CONSTRAINT "supplier_ledger_receiving_id_goods_receivings_id_fk" FOREIGN KEY ("receiving_id") REFERENCES "public"."goods_receivings"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_ledger" ADD CONSTRAINT "supplier_ledger_supplier_return_id_supplier_returns_id_fk" FOREIGN KEY ("supplier_return_id") REFERENCES "public"."supplier_returns"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_ledger" ADD CONSTRAINT "supplier_ledger_cash_move_id_cash_moves_id_fk" FOREIGN KEY ("cash_move_id") REFERENCES "public"."cash_moves"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_ledger" ADD CONSTRAINT "supplier_ledger_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_return_lines" ADD CONSTRAINT "supplier_return_lines_supplier_return_id_supplier_returns_id_fk" FOREIGN KEY ("supplier_return_id") REFERENCES "public"."supplier_returns"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_return_lines" ADD CONSTRAINT "supplier_return_lines_receiving_line_id_goods_receiving_lines_id_fk" FOREIGN KEY ("receiving_line_id") REFERENCES "public"."goods_receiving_lines"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_return_lines" ADD CONSTRAINT "supplier_return_lines_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_return_lines" ADD CONSTRAINT "supplier_return_lines_variant_id_product_variants_id_fk" FOREIGN KEY ("variant_id") REFERENCES "public"."product_variants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_return_lines" ADD CONSTRAINT "supplier_return_lines_batch_id_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."batches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_return_lines" ADD CONSTRAINT "supplier_return_lines_stock_move_id_stock_moves_id_fk" FOREIGN KEY ("stock_move_id") REFERENCES "public"."stock_moves"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_returns" ADD CONSTRAINT "supplier_returns_receiving_id_goods_receivings_id_fk" FOREIGN KEY ("receiving_id") REFERENCES "public"."goods_receivings"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_returns" ADD CONSTRAINT "supplier_returns_supplier_id_suppliers_id_fk" FOREIGN KEY ("supplier_id") REFERENCES "public"."suppliers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_returns" ADD CONSTRAINT "supplier_returns_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uidx_cloud_store_sync_positions_org_store" ON "cloud_store_sync_positions" USING btree ("organization_id","store_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uidx_cloud_sync_events_org_event" ON "cloud_sync_events" USING btree ("organization_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "uidx_cloud_sync_events_org_store_pos" ON "cloud_sync_events" USING btree ("organization_id","store_id","position");--> statement-breakpoint
CREATE INDEX "idx_cloud_sync_events_pull" ON "cloud_sync_events" USING btree ("organization_id","store_id","position");--> statement-breakpoint
CREATE INDEX "idx_cloud_sync_events_entity" ON "cloud_sync_events" USING btree ("organization_id","entity","entity_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uidx_cloud_sync_parked_event" ON "cloud_sync_parked" USING btree ("organization_id","event_id");--> statement-breakpoint
CREATE INDEX "idx_cloud_sync_parked_missing_ref" ON "cloud_sync_parked" USING btree ("organization_id","missing_ref_entity","missing_ref_id");--> statement-breakpoint
CREATE INDEX "idx_batches_store_prod_fifo" ON "batches" USING btree ("organization_id","store_id","product_id","variant_id","hlc","id");--> statement-breakpoint
CREATE INDEX "idx_cash_moves_store_created" ON "cash_moves" USING btree ("organization_id","store_id","created_at_ms");--> statement-breakpoint
CREATE INDEX "idx_cash_moves_terminal" ON "cash_moves" USING btree ("organization_id","store_id","device_id","created_at_ms");--> statement-breakpoint
CREATE INDEX "idx_cash_moves_shift_created" ON "cash_moves" USING btree ("organization_id","store_id","shift_id","created_at_ms");--> statement-breakpoint
CREATE INDEX "idx_cash_moves_session" ON "cash_moves" USING btree ("shift_cashier_session_id");--> statement-breakpoint
CREATE INDEX "idx_cash_moves_source" ON "cash_moves" USING btree ("source_type","source_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uidx_categories_org_root_name" ON "categories" USING btree ("organization_id","name_search") WHERE "categories"."parent_id" IS NULL AND "categories"."deleted_at_ms" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "uidx_categories_org_child_name" ON "categories" USING btree ("organization_id","parent_id","name_search") WHERE "categories"."parent_id" IS NOT NULL AND "categories"."deleted_at_ms" IS NULL;--> statement-breakpoint
CREATE INDEX "idx_categories_org_parent" ON "categories" USING btree ("organization_id","parent_id") WHERE "categories"."deleted_at_ms" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "uidx_customer_ledger_opening_balance" ON "customer_ledger" USING btree ("organization_id","customer_id") WHERE "customer_ledger"."entry_type" = 'opening_balance';--> statement-breakpoint
CREATE UNIQUE INDEX "uidx_customer_ledger_org_client_req" ON "customer_ledger" USING btree ("organization_id","client_request_id") WHERE "customer_ledger"."client_request_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_customer_ledger_cust_hlc" ON "customer_ledger" USING btree ("organization_id","customer_id","hlc","id");--> statement-breakpoint
CREATE INDEX "idx_customer_ledger_cust_created" ON "customer_ledger" USING btree ("organization_id","customer_id","created_at_ms","id");--> statement-breakpoint
CREATE INDEX "idx_customer_ledger_sale" ON "customer_ledger" USING btree ("sale_id") WHERE "customer_ledger"."sale_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "uidx_customers_org_phone_active" ON "customers" USING btree ("organization_id","phone_normalized") WHERE "customers"."deleted_at_ms" IS NULL AND "customers"."phone_normalized" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_customers_org_active_name" ON "customers" USING btree ("organization_id","deleted_at_ms","is_active","name_search","id");--> statement-breakpoint
CREATE INDEX "idx_customers_org_phone_digits" ON "customers" USING btree ("organization_id","phone_digits") WHERE "customers"."deleted_at_ms" IS NULL AND "customers"."phone_digits" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "uidx_day_closes_store_date_seq" ON "day_closes" USING btree ("organization_id","store_id","business_date","close_seq");--> statement-breakpoint
CREATE UNIQUE INDEX "uidx_day_closes_org_req" ON "day_closes" USING btree ("organization_id","client_request_id");--> statement-breakpoint
CREATE INDEX "idx_day_closes_store_date" ON "day_closes" USING btree ("organization_id","store_id","business_date","close_seq");--> statement-breakpoint
CREATE UNIQUE INDEX "uidx_goods_receiving_lines_sort" ON "goods_receiving_lines" USING btree ("receiving_id","sort_order");--> statement-breakpoint
CREATE UNIQUE INDEX "uidx_goods_receiving_lines_move" ON "goods_receiving_lines" USING btree ("stock_move_id");--> statement-breakpoint
CREATE INDEX "idx_goods_receiving_lines_rcv" ON "goods_receiving_lines" USING btree ("receiving_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uidx_goods_receivings_org_dev_no" ON "goods_receivings" USING btree ("organization_id","device_id","receiving_no");--> statement-breakpoint
CREATE UNIQUE INDEX "uidx_goods_receivings_org_client_req" ON "goods_receivings" USING btree ("organization_id","client_request_id");--> statement-breakpoint
CREATE INDEX "idx_goods_receivings_store_sup" ON "goods_receivings" USING btree ("organization_id","store_id","supplier_id","created_at_ms");--> statement-breakpoint
CREATE UNIQUE INDEX "uidx_inv_count_lines_prod" ON "inventory_count_lines" USING btree ("count_id","product_id") WHERE "inventory_count_lines"."variant_id" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "uidx_inv_count_lines_var" ON "inventory_count_lines" USING btree ("count_id","product_id","variant_id") WHERE "inventory_count_lines"."variant_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_inventory_counts_store_status" ON "inventory_counts" USING btree ("organization_id","store_id","status","created_at_ms");--> statement-breakpoint
CREATE UNIQUE INDEX "uidx_order_lines_order_sort" ON "order_lines" USING btree ("order_id","sort_order");--> statement-breakpoint
CREATE INDEX "idx_order_lines_store_order" ON "order_lines" USING btree ("organization_id","store_id","order_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uidx_order_payments_org_req_seq" ON "order_payments" USING btree ("organization_id","client_request_id","seq");--> statement-breakpoint
CREATE INDEX "idx_order_payments_order" ON "order_payments" USING btree ("order_id","created_at_ms","id");--> statement-breakpoint
CREATE INDEX "idx_order_payments_shift" ON "order_payments" USING btree ("shift_id","created_at_ms","id");--> statement-breakpoint
CREATE INDEX "idx_order_payments_store_kind" ON "order_payments" USING btree ("organization_id","store_id","kind");--> statement-breakpoint
CREATE UNIQUE INDEX "uidx_orders_org_origin_device_no" ON "orders" USING btree ("organization_id","origin_device_id","order_no");--> statement-breakpoint
CREATE UNIQUE INDEX "uidx_orders_org_create_req" ON "orders" USING btree ("organization_id","create_client_request_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uidx_orders_org_confirm_req" ON "orders" USING btree ("organization_id","confirm_client_request_id") WHERE "orders"."confirm_client_request_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "uidx_orders_org_ready_req" ON "orders" USING btree ("organization_id","ready_client_request_id") WHERE "orders"."ready_client_request_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "uidx_orders_org_deliver_req" ON "orders" USING btree ("organization_id","deliver_client_request_id") WHERE "orders"."deliver_client_request_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "uidx_orders_org_cancel_req" ON "orders" USING btree ("organization_id","cancel_client_request_id") WHERE "orders"."cancel_client_request_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_orders_store_status_created" ON "orders" USING btree ("organization_id","store_id","status","created_at_ms");--> statement-breakpoint
CREATE INDEX "idx_orders_store_customer" ON "orders" USING btree ("organization_id","store_id","customer_id","created_at_ms");--> statement-breakpoint
CREATE INDEX "idx_payments_sale" ON "payments" USING btree ("sale_id");--> statement-breakpoint
CREATE INDEX "idx_payments_store_created" ON "payments" USING btree ("organization_id","store_id","created_at_ms");--> statement-breakpoint
CREATE INDEX "idx_price_changes_org_product_time" ON "price_changes" USING btree ("organization_id","product_id","created_at_ms");--> statement-breakpoint
CREATE UNIQUE INDEX "uidx_product_barcodes_org_barcode" ON "product_barcodes" USING btree ("organization_id","barcode") WHERE "product_barcodes"."deleted_at_ms" IS NULL;--> statement-breakpoint
CREATE INDEX "idx_product_barcodes_org_product" ON "product_barcodes" USING btree ("organization_id","product_id") WHERE "product_barcodes"."deleted_at_ms" IS NULL;--> statement-breakpoint
CREATE INDEX "idx_product_barcodes_org_variant" ON "product_barcodes" USING btree ("organization_id","variant_id") WHERE "product_barcodes"."variant_id" IS NOT NULL AND "product_barcodes"."deleted_at_ms" IS NULL;--> statement-breakpoint
CREATE INDEX "idx_product_variants_org_product" ON "product_variants" USING btree ("organization_id","product_id") WHERE "product_variants"."deleted_at_ms" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "uidx_product_variants_org_sku" ON "product_variants" USING btree ("organization_id","sku") WHERE "product_variants"."sku" IS NOT NULL AND "product_variants"."deleted_at_ms" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "uidx_products_org_sku" ON "products" USING btree ("organization_id","sku") WHERE "products"."sku" IS NOT NULL AND "products"."deleted_at_ms" IS NULL;--> statement-breakpoint
CREATE INDEX "idx_products_org_name_search" ON "products" USING btree ("organization_id","name_search","id") WHERE "products"."deleted_at_ms" IS NULL;--> statement-breakpoint
CREATE INDEX "idx_products_org_sku_search" ON "products" USING btree ("organization_id","sku_search","id") WHERE "products"."sku_search" IS NOT NULL AND "products"."deleted_at_ms" IS NULL;--> statement-breakpoint
CREATE INDEX "idx_products_org_category" ON "products" USING btree ("organization_id","category_id") WHERE "products"."deleted_at_ms" IS NULL;--> statement-breakpoint
CREATE INDEX "idx_products_active_join" ON "products" USING btree ("id","organization_id","category_id") WHERE "products"."deleted_at_ms" IS NULL;--> statement-breakpoint
CREATE INDEX "idx_promotions_org_active" ON "promotions" USING btree ("organization_id","deleted_at_ms","is_active","starts_at_ms","ends_at_ms");--> statement-breakpoint
CREATE UNIQUE INDEX "uidx_receiving_cost_confirms_line" ON "receiving_cost_confirmations" USING btree ("organization_id","receiving_line_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uidx_receiving_cost_confirms_client_req" ON "receiving_cost_confirmations" USING btree ("organization_id","client_request_id");--> statement-breakpoint
CREATE INDEX "idx_receiving_cost_confirms_prod" ON "receiving_cost_confirmations" USING btree ("organization_id","store_id","product_id","hlc");--> statement-breakpoint
CREATE UNIQUE INDEX "uidx_return_lines_return_sale_line" ON "return_lines" USING btree ("return_id","sale_line_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uidx_return_lines_return_sort" ON "return_lines" USING btree ("return_id","sort_order");--> statement-breakpoint
CREATE INDEX "idx_return_lines_sale_line" ON "return_lines" USING btree ("sale_line_id");--> statement-breakpoint
CREATE INDEX "idx_return_lines_store_sale" ON "return_lines" USING btree ("organization_id","store_id","sale_id");--> statement-breakpoint
CREATE INDEX "idx_return_payments_return" ON "return_payments" USING btree ("return_id");--> statement-breakpoint
CREATE INDEX "idx_return_payments_sale" ON "return_payments" USING btree ("sale_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uidx_returns_org_device_return_no" ON "returns" USING btree ("organization_id","device_id","return_no");--> statement-breakpoint
CREATE UNIQUE INDEX "uidx_returns_org_client_request" ON "returns" USING btree ("organization_id","client_request_id");--> statement-breakpoint
CREATE INDEX "idx_returns_store_sale" ON "returns" USING btree ("organization_id","store_id","sale_id");--> statement-breakpoint
CREATE INDEX "idx_returns_store_created" ON "returns" USING btree ("organization_id","store_id","created_at_ms");--> statement-breakpoint
CREATE INDEX "idx_returns_shift_created" ON "returns" USING btree ("shift_id","created_at_ms");--> statement-breakpoint
CREATE INDEX "idx_returns_session" ON "returns" USING btree ("shift_cashier_session_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uidx_sale_lines_sale_sort" ON "sale_lines" USING btree ("sale_id","sort_order");--> statement-breakpoint
CREATE INDEX "idx_sale_lines_store_sale" ON "sale_lines" USING btree ("organization_id","store_id","sale_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uidx_sales_org_device_receipt_no" ON "sales" USING btree ("organization_id","device_id","receipt_no");--> statement-breakpoint
CREATE UNIQUE INDEX "uidx_sales_org_client_request" ON "sales" USING btree ("organization_id","client_request_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uidx_sales_org_void_client_req" ON "sales" USING btree ("organization_id","void_client_request_id") WHERE "sales"."void_client_request_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_sales_store_created" ON "sales" USING btree ("organization_id","store_id","created_at_ms");--> statement-breakpoint
CREATE INDEX "idx_sales_store_cart" ON "sales" USING btree ("organization_id","store_id","source_cart_id");--> statement-breakpoint
CREATE INDEX "idx_sales_store_order" ON "sales" USING btree ("organization_id","store_id","source_order_id");--> statement-breakpoint
CREATE INDEX "idx_sales_shift_created" ON "sales" USING btree ("shift_id","created_at_ms");--> statement-breakpoint
CREATE INDEX "idx_sales_session" ON "sales" USING btree ("shift_cashier_session_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uidx_shift_cashier_sessions_shift_seq" ON "shift_cashier_sessions" USING btree ("shift_id","session_seq");--> statement-breakpoint
CREATE UNIQUE INDEX "uidx_shift_cashier_one_active" ON "shift_cashier_sessions" USING btree ("shift_id") WHERE "shift_cashier_sessions"."status" = 'active';--> statement-breakpoint
CREATE UNIQUE INDEX "uidx_shift_cashier_handoff_req" ON "shift_cashier_sessions" USING btree ("organization_id","handoff_client_request_id") WHERE "shift_cashier_sessions"."handoff_client_request_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_shift_cashier_sessions_shift" ON "shift_cashier_sessions" USING btree ("shift_id","session_seq");--> statement-breakpoint
CREATE UNIQUE INDEX "uidx_shift_closure_cashiers_sess" ON "shift_closure_cashiers" USING btree ("shift_closure_id","session_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uidx_shift_closure_methods" ON "shift_closure_method_totals" USING btree ("shift_closure_id","method");--> statement-breakpoint
CREATE UNIQUE INDEX "uidx_shift_closures_shift_seq" ON "shift_closures" USING btree ("shift_id","closure_seq");--> statement-breakpoint
CREATE UNIQUE INDEX "uidx_shift_closures_org_req" ON "shift_closures" USING btree ("organization_id","client_request_id");--> statement-breakpoint
CREATE INDEX "idx_shift_closures_shift_seq" ON "shift_closures" USING btree ("shift_id","closure_seq");--> statement-breakpoint
CREATE UNIQUE INDEX "uidx_shifts_org_device_no" ON "shifts" USING btree ("organization_id","device_id","shift_no");--> statement-breakpoint
CREATE UNIQUE INDEX "uidx_shifts_one_open_per_device" ON "shifts" USING btree ("organization_id","store_id","device_id") WHERE "shifts"."status" = 'open';--> statement-breakpoint
CREATE UNIQUE INDEX "uidx_shifts_org_open_req" ON "shifts" USING btree ("organization_id","open_client_request_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uidx_shifts_org_close_req" ON "shifts" USING btree ("organization_id","close_client_request_id") WHERE "shifts"."close_client_request_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_shifts_store_closed" ON "shifts" USING btree ("organization_id","store_id","status","closed_at_ms");--> statement-breakpoint
CREATE INDEX "idx_shifts_store_opened" ON "shifts" USING btree ("organization_id","store_id","status","opened_at_ms");--> statement-breakpoint
CREATE INDEX "idx_stock_moves_store_prod_hlc" ON "stock_moves" USING btree ("organization_id","store_id","product_id","variant_id","hlc","id");--> statement-breakpoint
CREATE INDEX "idx_stock_moves_store_batch" ON "stock_moves" USING btree ("organization_id","store_id","batch_id","hlc","id");--> statement-breakpoint
CREATE INDEX "idx_stock_moves_store_source" ON "stock_moves" USING btree ("organization_id","store_id","source_type","source_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uidx_supplier_ledger_opening_balance" ON "supplier_ledger" USING btree ("organization_id","supplier_id") WHERE "supplier_ledger"."entry_type" = 'opening_balance';--> statement-breakpoint
CREATE UNIQUE INDEX "uidx_supplier_ledger_org_client_req" ON "supplier_ledger" USING btree ("organization_id","client_request_id") WHERE "supplier_ledger"."client_request_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_supplier_ledger_org_sup_hlc" ON "supplier_ledger" USING btree ("organization_id","supplier_id","hlc","id");--> statement-breakpoint
CREATE INDEX "idx_supplier_ledger_receiving" ON "supplier_ledger" USING btree ("receiving_id") WHERE "supplier_ledger"."receiving_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "uidx_supplier_return_lines_sort" ON "supplier_return_lines" USING btree ("supplier_return_id","sort_order");--> statement-breakpoint
CREATE UNIQUE INDEX "uidx_supplier_return_lines_move" ON "supplier_return_lines" USING btree ("stock_move_id");--> statement-breakpoint
CREATE INDEX "idx_supplier_return_lines_rcv_line" ON "supplier_return_lines" USING btree ("receiving_line_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uidx_supplier_returns_org_dev_no" ON "supplier_returns" USING btree ("organization_id","device_id","return_no");--> statement-breakpoint
CREATE UNIQUE INDEX "uidx_supplier_returns_org_client_req" ON "supplier_returns" USING btree ("organization_id","client_request_id");--> statement-breakpoint
CREATE INDEX "idx_supplier_returns_rcv" ON "supplier_returns" USING btree ("receiving_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uidx_suppliers_org_tin_active" ON "suppliers" USING btree ("organization_id","tin") WHERE "suppliers"."tin" IS NOT NULL AND "suppliers"."deleted_at_ms" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "uidx_suppliers_org_phone_active" ON "suppliers" USING btree ("organization_id","phone_normalized") WHERE "suppliers"."phone_normalized" IS NOT NULL AND "suppliers"."deleted_at_ms" IS NULL;--> statement-breakpoint
CREATE INDEX "idx_suppliers_org_active_name" ON "suppliers" USING btree ("organization_id","is_active","name_search") WHERE "suppliers"."deleted_at_ms" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "uidx_users_org_username" ON "users" USING btree ("organization_id","username") WHERE "users"."deleted_at_ms" IS NULL;--> statement-breakpoint
CREATE INDEX "idx_users_org_active_role" ON "users" USING btree ("organization_id","deleted_at_ms","is_active");--> statement-breakpoint
CREATE POLICY "cloud_store_sync_positions_tenant_isolation" ON "cloud_store_sync_positions" AS PERMISSIVE FOR ALL TO "mezon_app" USING ("organization_id" = mezon_current_organization_id()) WITH CHECK ("organization_id" = mezon_current_organization_id());--> statement-breakpoint
CREATE POLICY "cloud_sync_events_tenant_isolation" ON "cloud_sync_events" AS PERMISSIVE FOR ALL TO "mezon_app" USING ("organization_id" = mezon_current_organization_id()) WITH CHECK ("organization_id" = mezon_current_organization_id());--> statement-breakpoint
CREATE POLICY "cloud_sync_parked_tenant_isolation" ON "cloud_sync_parked" AS PERMISSIVE FOR ALL TO "mezon_app" USING ("organization_id" = mezon_current_organization_id()) WITH CHECK ("organization_id" = mezon_current_organization_id());--> statement-breakpoint
CREATE POLICY "batches_tenant_isolation" ON "batches" AS PERMISSIVE FOR ALL TO "mezon_app" USING ("organization_id" = mezon_current_organization_id()) WITH CHECK ("organization_id" = mezon_current_organization_id());--> statement-breakpoint
CREATE POLICY "cash_moves_tenant_isolation" ON "cash_moves" AS PERMISSIVE FOR ALL TO "mezon_app" USING ("organization_id" = mezon_current_organization_id()) WITH CHECK ("organization_id" = mezon_current_organization_id());--> statement-breakpoint
CREATE POLICY "categories_tenant_isolation" ON "categories" AS PERMISSIVE FOR ALL TO "mezon_app" USING ("organization_id" = mezon_current_organization_id()) WITH CHECK ("organization_id" = mezon_current_organization_id());--> statement-breakpoint
CREATE POLICY "customer_ledger_tenant_isolation" ON "customer_ledger" AS PERMISSIVE FOR ALL TO "mezon_app" USING ("organization_id" = mezon_current_organization_id()) WITH CHECK ("organization_id" = mezon_current_organization_id());--> statement-breakpoint
CREATE POLICY "customers_tenant_isolation" ON "customers" AS PERMISSIVE FOR ALL TO "mezon_app" USING ("organization_id" = mezon_current_organization_id()) WITH CHECK ("organization_id" = mezon_current_organization_id());--> statement-breakpoint
CREATE POLICY "day_closes_tenant_isolation" ON "day_closes" AS PERMISSIVE FOR ALL TO "mezon_app" USING ("organization_id" = mezon_current_organization_id()) WITH CHECK ("organization_id" = mezon_current_organization_id());--> statement-breakpoint
CREATE POLICY "goods_receiving_lines_tenant_isolation" ON "goods_receiving_lines" AS PERMISSIVE FOR ALL TO "mezon_app" USING ("organization_id" = mezon_current_organization_id()) WITH CHECK ("organization_id" = mezon_current_organization_id());--> statement-breakpoint
CREATE POLICY "goods_receivings_tenant_isolation" ON "goods_receivings" AS PERMISSIVE FOR ALL TO "mezon_app" USING ("organization_id" = mezon_current_organization_id()) WITH CHECK ("organization_id" = mezon_current_organization_id());--> statement-breakpoint
CREATE POLICY "inventory_count_lines_tenant_isolation" ON "inventory_count_lines" AS PERMISSIVE FOR ALL TO "mezon_app" USING ("organization_id" = mezon_current_organization_id()) WITH CHECK ("organization_id" = mezon_current_organization_id());--> statement-breakpoint
CREATE POLICY "inventory_counts_tenant_isolation" ON "inventory_counts" AS PERMISSIVE FOR ALL TO "mezon_app" USING ("organization_id" = mezon_current_organization_id()) WITH CHECK ("organization_id" = mezon_current_organization_id());--> statement-breakpoint
CREATE POLICY "order_lines_tenant_isolation" ON "order_lines" AS PERMISSIVE FOR ALL TO "mezon_app" USING ("organization_id" = mezon_current_organization_id()) WITH CHECK ("organization_id" = mezon_current_organization_id());--> statement-breakpoint
CREATE POLICY "order_payments_tenant_isolation" ON "order_payments" AS PERMISSIVE FOR ALL TO "mezon_app" USING ("organization_id" = mezon_current_organization_id()) WITH CHECK ("organization_id" = mezon_current_organization_id());--> statement-breakpoint
CREATE POLICY "orders_tenant_isolation" ON "orders" AS PERMISSIVE FOR ALL TO "mezon_app" USING ("organization_id" = mezon_current_organization_id()) WITH CHECK ("organization_id" = mezon_current_organization_id());--> statement-breakpoint
CREATE POLICY "payments_tenant_isolation" ON "payments" AS PERMISSIVE FOR ALL TO "mezon_app" USING ("organization_id" = mezon_current_organization_id()) WITH CHECK ("organization_id" = mezon_current_organization_id());--> statement-breakpoint
CREATE POLICY "price_changes_tenant_isolation" ON "price_changes" AS PERMISSIVE FOR ALL TO "mezon_app" USING ("organization_id" = mezon_current_organization_id()) WITH CHECK ("organization_id" = mezon_current_organization_id());--> statement-breakpoint
CREATE POLICY "product_barcodes_tenant_isolation" ON "product_barcodes" AS PERMISSIVE FOR ALL TO "mezon_app" USING ("organization_id" = mezon_current_organization_id()) WITH CHECK ("organization_id" = mezon_current_organization_id());--> statement-breakpoint
CREATE POLICY "product_variants_tenant_isolation" ON "product_variants" AS PERMISSIVE FOR ALL TO "mezon_app" USING ("organization_id" = mezon_current_organization_id()) WITH CHECK ("organization_id" = mezon_current_organization_id());--> statement-breakpoint
CREATE POLICY "products_tenant_isolation" ON "products" AS PERMISSIVE FOR ALL TO "mezon_app" USING ("organization_id" = mezon_current_organization_id()) WITH CHECK ("organization_id" = mezon_current_organization_id());--> statement-breakpoint
CREATE POLICY "promotions_tenant_isolation" ON "promotions" AS PERMISSIVE FOR ALL TO "mezon_app" USING ("organization_id" = mezon_current_organization_id()) WITH CHECK ("organization_id" = mezon_current_organization_id());--> statement-breakpoint
CREATE POLICY "receiving_cost_confirmations_tenant_isolation" ON "receiving_cost_confirmations" AS PERMISSIVE FOR ALL TO "mezon_app" USING ("organization_id" = mezon_current_organization_id()) WITH CHECK ("organization_id" = mezon_current_organization_id());--> statement-breakpoint
CREATE POLICY "return_lines_tenant_isolation" ON "return_lines" AS PERMISSIVE FOR ALL TO "mezon_app" USING ("organization_id" = mezon_current_organization_id()) WITH CHECK ("organization_id" = mezon_current_organization_id());--> statement-breakpoint
CREATE POLICY "return_payments_tenant_isolation" ON "return_payments" AS PERMISSIVE FOR ALL TO "mezon_app" USING ("organization_id" = mezon_current_organization_id()) WITH CHECK ("organization_id" = mezon_current_organization_id());--> statement-breakpoint
CREATE POLICY "returns_tenant_isolation" ON "returns" AS PERMISSIVE FOR ALL TO "mezon_app" USING ("organization_id" = mezon_current_organization_id()) WITH CHECK ("organization_id" = mezon_current_organization_id());--> statement-breakpoint
CREATE POLICY "sale_lines_tenant_isolation" ON "sale_lines" AS PERMISSIVE FOR ALL TO "mezon_app" USING ("organization_id" = mezon_current_organization_id()) WITH CHECK ("organization_id" = mezon_current_organization_id());--> statement-breakpoint
CREATE POLICY "sales_tenant_isolation" ON "sales" AS PERMISSIVE FOR ALL TO "mezon_app" USING ("organization_id" = mezon_current_organization_id()) WITH CHECK ("organization_id" = mezon_current_organization_id());--> statement-breakpoint
CREATE POLICY "shift_cashier_sessions_tenant_isolation" ON "shift_cashier_sessions" AS PERMISSIVE FOR ALL TO "mezon_app" USING ("organization_id" = mezon_current_organization_id()) WITH CHECK ("organization_id" = mezon_current_organization_id());--> statement-breakpoint
CREATE POLICY "shift_closure_cashiers_tenant_isolation" ON "shift_closure_cashiers" AS PERMISSIVE FOR ALL TO "mezon_app" USING ("organization_id" = mezon_current_organization_id()) WITH CHECK ("organization_id" = mezon_current_organization_id());--> statement-breakpoint
CREATE POLICY "shift_closure_method_totals_tenant_isolation" ON "shift_closure_method_totals" AS PERMISSIVE FOR ALL TO "mezon_app" USING ("organization_id" = mezon_current_organization_id()) WITH CHECK ("organization_id" = mezon_current_organization_id());--> statement-breakpoint
CREATE POLICY "shift_closures_tenant_isolation" ON "shift_closures" AS PERMISSIVE FOR ALL TO "mezon_app" USING ("organization_id" = mezon_current_organization_id()) WITH CHECK ("organization_id" = mezon_current_organization_id());--> statement-breakpoint
CREATE POLICY "shifts_tenant_isolation" ON "shifts" AS PERMISSIVE FOR ALL TO "mezon_app" USING ("organization_id" = mezon_current_organization_id()) WITH CHECK ("organization_id" = mezon_current_organization_id());--> statement-breakpoint
CREATE POLICY "stock_moves_tenant_isolation" ON "stock_moves" AS PERMISSIVE FOR ALL TO "mezon_app" USING ("organization_id" = mezon_current_organization_id()) WITH CHECK ("organization_id" = mezon_current_organization_id());--> statement-breakpoint
CREATE POLICY "supplier_ledger_tenant_isolation" ON "supplier_ledger" AS PERMISSIVE FOR ALL TO "mezon_app" USING ("organization_id" = mezon_current_organization_id()) WITH CHECK ("organization_id" = mezon_current_organization_id());--> statement-breakpoint
CREATE POLICY "supplier_return_lines_tenant_isolation" ON "supplier_return_lines" AS PERMISSIVE FOR ALL TO "mezon_app" USING ("organization_id" = mezon_current_organization_id()) WITH CHECK ("organization_id" = mezon_current_organization_id());--> statement-breakpoint
CREATE POLICY "supplier_returns_tenant_isolation" ON "supplier_returns" AS PERMISSIVE FOR ALL TO "mezon_app" USING ("organization_id" = mezon_current_organization_id()) WITH CHECK ("organization_id" = mezon_current_organization_id());--> statement-breakpoint
CREATE POLICY "suppliers_tenant_isolation" ON "suppliers" AS PERMISSIVE FOR ALL TO "mezon_app" USING ("organization_id" = mezon_current_organization_id()) WITH CHECK ("organization_id" = mezon_current_organization_id());--> statement-breakpoint
CREATE POLICY "users_tenant_isolation" ON "users" AS PERMISSIVE FOR ALL TO "mezon_app" USING ("organization_id" = mezon_current_organization_id()) WITH CHECK ("organization_id" = mezon_current_organization_id());
--> statement-breakpoint
ALTER TABLE "cloud_sync_events" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "cloud_sync_events" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "cloud_sync_events_tenant_isolation" ON "cloud_sync_events";
--> statement-breakpoint
CREATE POLICY "cloud_sync_events_tenant_isolation" ON "cloud_sync_events" AS PERMISSIVE FOR ALL TO "mezon_app" USING ("organization_id" = mezon_current_organization_id()) WITH CHECK ("organization_id" = mezon_current_organization_id());
--> statement-breakpoint
REVOKE ALL ON TABLE "cloud_sync_events" FROM "mezon_app";
--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE "cloud_sync_events" TO "mezon_app";

--> statement-breakpoint
ALTER TABLE "users" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "users" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "users_tenant_isolation" ON "users";
--> statement-breakpoint
CREATE POLICY "users_tenant_isolation" ON "users" AS PERMISSIVE FOR ALL TO "mezon_app" USING ("organization_id" = mezon_current_organization_id()) WITH CHECK ("organization_id" = mezon_current_organization_id());
--> statement-breakpoint
REVOKE ALL ON TABLE "users" FROM "mezon_app";
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON TABLE "users" TO "mezon_app";

--> statement-breakpoint
ALTER TABLE "categories" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "categories" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "categories_tenant_isolation" ON "categories";
--> statement-breakpoint
CREATE POLICY "categories_tenant_isolation" ON "categories" AS PERMISSIVE FOR ALL TO "mezon_app" USING ("organization_id" = mezon_current_organization_id()) WITH CHECK ("organization_id" = mezon_current_organization_id());
--> statement-breakpoint
REVOKE ALL ON TABLE "categories" FROM "mezon_app";
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON TABLE "categories" TO "mezon_app";

--> statement-breakpoint
ALTER TABLE "products" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "products" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "products_tenant_isolation" ON "products";
--> statement-breakpoint
CREATE POLICY "products_tenant_isolation" ON "products" AS PERMISSIVE FOR ALL TO "mezon_app" USING ("organization_id" = mezon_current_organization_id()) WITH CHECK ("organization_id" = mezon_current_organization_id());
--> statement-breakpoint
REVOKE ALL ON TABLE "products" FROM "mezon_app";
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON TABLE "products" TO "mezon_app";

--> statement-breakpoint
ALTER TABLE "product_variants" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "product_variants" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "product_variants_tenant_isolation" ON "product_variants";
--> statement-breakpoint
CREATE POLICY "product_variants_tenant_isolation" ON "product_variants" AS PERMISSIVE FOR ALL TO "mezon_app" USING ("organization_id" = mezon_current_organization_id()) WITH CHECK ("organization_id" = mezon_current_organization_id());
--> statement-breakpoint
REVOKE ALL ON TABLE "product_variants" FROM "mezon_app";
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON TABLE "product_variants" TO "mezon_app";

--> statement-breakpoint
ALTER TABLE "product_barcodes" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "product_barcodes" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "product_barcodes_tenant_isolation" ON "product_barcodes";
--> statement-breakpoint
CREATE POLICY "product_barcodes_tenant_isolation" ON "product_barcodes" AS PERMISSIVE FOR ALL TO "mezon_app" USING ("organization_id" = mezon_current_organization_id()) WITH CHECK ("organization_id" = mezon_current_organization_id());
--> statement-breakpoint
REVOKE ALL ON TABLE "product_barcodes" FROM "mezon_app";
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON TABLE "product_barcodes" TO "mezon_app";

--> statement-breakpoint
ALTER TABLE "price_changes" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "price_changes" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "price_changes_tenant_isolation" ON "price_changes";
--> statement-breakpoint
CREATE POLICY "price_changes_tenant_isolation" ON "price_changes" AS PERMISSIVE FOR ALL TO "mezon_app" USING ("organization_id" = mezon_current_organization_id()) WITH CHECK ("organization_id" = mezon_current_organization_id());
--> statement-breakpoint
REVOKE ALL ON TABLE "price_changes" FROM "mezon_app";
--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE "price_changes" TO "mezon_app";

--> statement-breakpoint
ALTER TABLE "batches" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "batches" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "batches_tenant_isolation" ON "batches";
--> statement-breakpoint
CREATE POLICY "batches_tenant_isolation" ON "batches" AS PERMISSIVE FOR ALL TO "mezon_app" USING ("organization_id" = mezon_current_organization_id()) WITH CHECK ("organization_id" = mezon_current_organization_id());
--> statement-breakpoint
REVOKE ALL ON TABLE "batches" FROM "mezon_app";
--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE "batches" TO "mezon_app";

--> statement-breakpoint
ALTER TABLE "stock_moves" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "stock_moves" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "stock_moves_tenant_isolation" ON "stock_moves";
--> statement-breakpoint
CREATE POLICY "stock_moves_tenant_isolation" ON "stock_moves" AS PERMISSIVE FOR ALL TO "mezon_app" USING ("organization_id" = mezon_current_organization_id()) WITH CHECK ("organization_id" = mezon_current_organization_id());
--> statement-breakpoint
REVOKE ALL ON TABLE "stock_moves" FROM "mezon_app";
--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE "stock_moves" TO "mezon_app";

--> statement-breakpoint
ALTER TABLE "inventory_counts" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "inventory_counts" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "inventory_counts_tenant_isolation" ON "inventory_counts";
--> statement-breakpoint
CREATE POLICY "inventory_counts_tenant_isolation" ON "inventory_counts" AS PERMISSIVE FOR ALL TO "mezon_app" USING ("organization_id" = mezon_current_organization_id()) WITH CHECK ("organization_id" = mezon_current_organization_id());
--> statement-breakpoint
REVOKE ALL ON TABLE "inventory_counts" FROM "mezon_app";
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON TABLE "inventory_counts" TO "mezon_app";

--> statement-breakpoint
ALTER TABLE "inventory_count_lines" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "inventory_count_lines" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "inventory_count_lines_tenant_isolation" ON "inventory_count_lines";
--> statement-breakpoint
CREATE POLICY "inventory_count_lines_tenant_isolation" ON "inventory_count_lines" AS PERMISSIVE FOR ALL TO "mezon_app" USING ("organization_id" = mezon_current_organization_id()) WITH CHECK ("organization_id" = mezon_current_organization_id());
--> statement-breakpoint
REVOKE ALL ON TABLE "inventory_count_lines" FROM "mezon_app";
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON TABLE "inventory_count_lines" TO "mezon_app";

--> statement-breakpoint
ALTER TABLE "promotions" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "promotions" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "promotions_tenant_isolation" ON "promotions";
--> statement-breakpoint
CREATE POLICY "promotions_tenant_isolation" ON "promotions" AS PERMISSIVE FOR ALL TO "mezon_app" USING ("organization_id" = mezon_current_organization_id()) WITH CHECK ("organization_id" = mezon_current_organization_id());
--> statement-breakpoint
REVOKE ALL ON TABLE "promotions" FROM "mezon_app";
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON TABLE "promotions" TO "mezon_app";

--> statement-breakpoint
ALTER TABLE "sales" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "sales" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "sales_tenant_isolation" ON "sales";
--> statement-breakpoint
CREATE POLICY "sales_tenant_isolation" ON "sales" AS PERMISSIVE FOR ALL TO "mezon_app" USING ("organization_id" = mezon_current_organization_id()) WITH CHECK ("organization_id" = mezon_current_organization_id());
--> statement-breakpoint
REVOKE ALL ON TABLE "sales" FROM "mezon_app";
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON TABLE "sales" TO "mezon_app";

--> statement-breakpoint
ALTER TABLE "sale_lines" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "sale_lines" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "sale_lines_tenant_isolation" ON "sale_lines";
--> statement-breakpoint
CREATE POLICY "sale_lines_tenant_isolation" ON "sale_lines" AS PERMISSIVE FOR ALL TO "mezon_app" USING ("organization_id" = mezon_current_organization_id()) WITH CHECK ("organization_id" = mezon_current_organization_id());
--> statement-breakpoint
REVOKE ALL ON TABLE "sale_lines" FROM "mezon_app";
--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE "sale_lines" TO "mezon_app";

--> statement-breakpoint
ALTER TABLE "payments" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "payments" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "payments_tenant_isolation" ON "payments";
--> statement-breakpoint
CREATE POLICY "payments_tenant_isolation" ON "payments" AS PERMISSIVE FOR ALL TO "mezon_app" USING ("organization_id" = mezon_current_organization_id()) WITH CHECK ("organization_id" = mezon_current_organization_id());
--> statement-breakpoint
REVOKE ALL ON TABLE "payments" FROM "mezon_app";
--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE "payments" TO "mezon_app";

--> statement-breakpoint
ALTER TABLE "cash_moves" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "cash_moves" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "cash_moves_tenant_isolation" ON "cash_moves";
--> statement-breakpoint
CREATE POLICY "cash_moves_tenant_isolation" ON "cash_moves" AS PERMISSIVE FOR ALL TO "mezon_app" USING ("organization_id" = mezon_current_organization_id()) WITH CHECK ("organization_id" = mezon_current_organization_id());
--> statement-breakpoint
REVOKE ALL ON TABLE "cash_moves" FROM "mezon_app";
--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE "cash_moves" TO "mezon_app";

--> statement-breakpoint
ALTER TABLE "returns" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "returns" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "returns_tenant_isolation" ON "returns";
--> statement-breakpoint
CREATE POLICY "returns_tenant_isolation" ON "returns" AS PERMISSIVE FOR ALL TO "mezon_app" USING ("organization_id" = mezon_current_organization_id()) WITH CHECK ("organization_id" = mezon_current_organization_id());
--> statement-breakpoint
REVOKE ALL ON TABLE "returns" FROM "mezon_app";
--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE "returns" TO "mezon_app";

--> statement-breakpoint
ALTER TABLE "return_lines" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "return_lines" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "return_lines_tenant_isolation" ON "return_lines";
--> statement-breakpoint
CREATE POLICY "return_lines_tenant_isolation" ON "return_lines" AS PERMISSIVE FOR ALL TO "mezon_app" USING ("organization_id" = mezon_current_organization_id()) WITH CHECK ("organization_id" = mezon_current_organization_id());
--> statement-breakpoint
REVOKE ALL ON TABLE "return_lines" FROM "mezon_app";
--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE "return_lines" TO "mezon_app";

--> statement-breakpoint
ALTER TABLE "return_payments" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "return_payments" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "return_payments_tenant_isolation" ON "return_payments";
--> statement-breakpoint
CREATE POLICY "return_payments_tenant_isolation" ON "return_payments" AS PERMISSIVE FOR ALL TO "mezon_app" USING ("organization_id" = mezon_current_organization_id()) WITH CHECK ("organization_id" = mezon_current_organization_id());
--> statement-breakpoint
REVOKE ALL ON TABLE "return_payments" FROM "mezon_app";
--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE "return_payments" TO "mezon_app";

--> statement-breakpoint
ALTER TABLE "customers" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "customers" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "customers_tenant_isolation" ON "customers";
--> statement-breakpoint
CREATE POLICY "customers_tenant_isolation" ON "customers" AS PERMISSIVE FOR ALL TO "mezon_app" USING ("organization_id" = mezon_current_organization_id()) WITH CHECK ("organization_id" = mezon_current_organization_id());
--> statement-breakpoint
REVOKE ALL ON TABLE "customers" FROM "mezon_app";
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON TABLE "customers" TO "mezon_app";

--> statement-breakpoint
ALTER TABLE "customer_ledger" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "customer_ledger" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "customer_ledger_tenant_isolation" ON "customer_ledger";
--> statement-breakpoint
CREATE POLICY "customer_ledger_tenant_isolation" ON "customer_ledger" AS PERMISSIVE FOR ALL TO "mezon_app" USING ("organization_id" = mezon_current_organization_id()) WITH CHECK ("organization_id" = mezon_current_organization_id());
--> statement-breakpoint
REVOKE ALL ON TABLE "customer_ledger" FROM "mezon_app";
--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE "customer_ledger" TO "mezon_app";

--> statement-breakpoint
ALTER TABLE "suppliers" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "suppliers" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "suppliers_tenant_isolation" ON "suppliers";
--> statement-breakpoint
CREATE POLICY "suppliers_tenant_isolation" ON "suppliers" AS PERMISSIVE FOR ALL TO "mezon_app" USING ("organization_id" = mezon_current_organization_id()) WITH CHECK ("organization_id" = mezon_current_organization_id());
--> statement-breakpoint
REVOKE ALL ON TABLE "suppliers" FROM "mezon_app";
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON TABLE "suppliers" TO "mezon_app";

--> statement-breakpoint
ALTER TABLE "goods_receivings" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "goods_receivings" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "goods_receivings_tenant_isolation" ON "goods_receivings";
--> statement-breakpoint
CREATE POLICY "goods_receivings_tenant_isolation" ON "goods_receivings" AS PERMISSIVE FOR ALL TO "mezon_app" USING ("organization_id" = mezon_current_organization_id()) WITH CHECK ("organization_id" = mezon_current_organization_id());
--> statement-breakpoint
REVOKE ALL ON TABLE "goods_receivings" FROM "mezon_app";
--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE "goods_receivings" TO "mezon_app";

--> statement-breakpoint
ALTER TABLE "goods_receiving_lines" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "goods_receiving_lines" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "goods_receiving_lines_tenant_isolation" ON "goods_receiving_lines";
--> statement-breakpoint
CREATE POLICY "goods_receiving_lines_tenant_isolation" ON "goods_receiving_lines" AS PERMISSIVE FOR ALL TO "mezon_app" USING ("organization_id" = mezon_current_organization_id()) WITH CHECK ("organization_id" = mezon_current_organization_id());
--> statement-breakpoint
REVOKE ALL ON TABLE "goods_receiving_lines" FROM "mezon_app";
--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE "goods_receiving_lines" TO "mezon_app";

--> statement-breakpoint
ALTER TABLE "receiving_cost_confirmations" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "receiving_cost_confirmations" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "receiving_cost_confirmations_tenant_isolation" ON "receiving_cost_confirmations";
--> statement-breakpoint
CREATE POLICY "receiving_cost_confirmations_tenant_isolation" ON "receiving_cost_confirmations" AS PERMISSIVE FOR ALL TO "mezon_app" USING ("organization_id" = mezon_current_organization_id()) WITH CHECK ("organization_id" = mezon_current_organization_id());
--> statement-breakpoint
REVOKE ALL ON TABLE "receiving_cost_confirmations" FROM "mezon_app";
--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE "receiving_cost_confirmations" TO "mezon_app";

--> statement-breakpoint
ALTER TABLE "supplier_returns" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "supplier_returns" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "supplier_returns_tenant_isolation" ON "supplier_returns";
--> statement-breakpoint
CREATE POLICY "supplier_returns_tenant_isolation" ON "supplier_returns" AS PERMISSIVE FOR ALL TO "mezon_app" USING ("organization_id" = mezon_current_organization_id()) WITH CHECK ("organization_id" = mezon_current_organization_id());
--> statement-breakpoint
REVOKE ALL ON TABLE "supplier_returns" FROM "mezon_app";
--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE "supplier_returns" TO "mezon_app";

--> statement-breakpoint
ALTER TABLE "supplier_return_lines" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "supplier_return_lines" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "supplier_return_lines_tenant_isolation" ON "supplier_return_lines";
--> statement-breakpoint
CREATE POLICY "supplier_return_lines_tenant_isolation" ON "supplier_return_lines" AS PERMISSIVE FOR ALL TO "mezon_app" USING ("organization_id" = mezon_current_organization_id()) WITH CHECK ("organization_id" = mezon_current_organization_id());
--> statement-breakpoint
REVOKE ALL ON TABLE "supplier_return_lines" FROM "mezon_app";
--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE "supplier_return_lines" TO "mezon_app";

--> statement-breakpoint
ALTER TABLE "supplier_ledger" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "supplier_ledger" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "supplier_ledger_tenant_isolation" ON "supplier_ledger";
--> statement-breakpoint
CREATE POLICY "supplier_ledger_tenant_isolation" ON "supplier_ledger" AS PERMISSIVE FOR ALL TO "mezon_app" USING ("organization_id" = mezon_current_organization_id()) WITH CHECK ("organization_id" = mezon_current_organization_id());
--> statement-breakpoint
REVOKE ALL ON TABLE "supplier_ledger" FROM "mezon_app";
--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE "supplier_ledger" TO "mezon_app";

--> statement-breakpoint
ALTER TABLE "shifts" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "shifts" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "shifts_tenant_isolation" ON "shifts";
--> statement-breakpoint
CREATE POLICY "shifts_tenant_isolation" ON "shifts" AS PERMISSIVE FOR ALL TO "mezon_app" USING ("organization_id" = mezon_current_organization_id()) WITH CHECK ("organization_id" = mezon_current_organization_id());
--> statement-breakpoint
REVOKE ALL ON TABLE "shifts" FROM "mezon_app";
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON TABLE "shifts" TO "mezon_app";

--> statement-breakpoint
ALTER TABLE "shift_cashier_sessions" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "shift_cashier_sessions" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "shift_cashier_sessions_tenant_isolation" ON "shift_cashier_sessions";
--> statement-breakpoint
CREATE POLICY "shift_cashier_sessions_tenant_isolation" ON "shift_cashier_sessions" AS PERMISSIVE FOR ALL TO "mezon_app" USING ("organization_id" = mezon_current_organization_id()) WITH CHECK ("organization_id" = mezon_current_organization_id());
--> statement-breakpoint
REVOKE ALL ON TABLE "shift_cashier_sessions" FROM "mezon_app";
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON TABLE "shift_cashier_sessions" TO "mezon_app";

--> statement-breakpoint
ALTER TABLE "shift_closures" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "shift_closures" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "shift_closures_tenant_isolation" ON "shift_closures";
--> statement-breakpoint
CREATE POLICY "shift_closures_tenant_isolation" ON "shift_closures" AS PERMISSIVE FOR ALL TO "mezon_app" USING ("organization_id" = mezon_current_organization_id()) WITH CHECK ("organization_id" = mezon_current_organization_id());
--> statement-breakpoint
REVOKE ALL ON TABLE "shift_closures" FROM "mezon_app";
--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE "shift_closures" TO "mezon_app";

--> statement-breakpoint
ALTER TABLE "shift_closure_method_totals" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "shift_closure_method_totals" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "shift_closure_method_totals_tenant_isolation" ON "shift_closure_method_totals";
--> statement-breakpoint
CREATE POLICY "shift_closure_method_totals_tenant_isolation" ON "shift_closure_method_totals" AS PERMISSIVE FOR ALL TO "mezon_app" USING ("organization_id" = mezon_current_organization_id()) WITH CHECK ("organization_id" = mezon_current_organization_id());
--> statement-breakpoint
REVOKE ALL ON TABLE "shift_closure_method_totals" FROM "mezon_app";
--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE "shift_closure_method_totals" TO "mezon_app";

--> statement-breakpoint
ALTER TABLE "shift_closure_cashiers" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "shift_closure_cashiers" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "shift_closure_cashiers_tenant_isolation" ON "shift_closure_cashiers";
--> statement-breakpoint
CREATE POLICY "shift_closure_cashiers_tenant_isolation" ON "shift_closure_cashiers" AS PERMISSIVE FOR ALL TO "mezon_app" USING ("organization_id" = mezon_current_organization_id()) WITH CHECK ("organization_id" = mezon_current_organization_id());
--> statement-breakpoint
REVOKE ALL ON TABLE "shift_closure_cashiers" FROM "mezon_app";
--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE "shift_closure_cashiers" TO "mezon_app";

--> statement-breakpoint
ALTER TABLE "day_closes" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "day_closes" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "day_closes_tenant_isolation" ON "day_closes";
--> statement-breakpoint
CREATE POLICY "day_closes_tenant_isolation" ON "day_closes" AS PERMISSIVE FOR ALL TO "mezon_app" USING ("organization_id" = mezon_current_organization_id()) WITH CHECK ("organization_id" = mezon_current_organization_id());
--> statement-breakpoint
REVOKE ALL ON TABLE "day_closes" FROM "mezon_app";
--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE "day_closes" TO "mezon_app";

--> statement-breakpoint
ALTER TABLE "orders" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "orders" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "orders_tenant_isolation" ON "orders";
--> statement-breakpoint
CREATE POLICY "orders_tenant_isolation" ON "orders" AS PERMISSIVE FOR ALL TO "mezon_app" USING ("organization_id" = mezon_current_organization_id()) WITH CHECK ("organization_id" = mezon_current_organization_id());
--> statement-breakpoint
REVOKE ALL ON TABLE "orders" FROM "mezon_app";
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON TABLE "orders" TO "mezon_app";

--> statement-breakpoint
ALTER TABLE "order_lines" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "order_lines" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "order_lines_tenant_isolation" ON "order_lines";
--> statement-breakpoint
CREATE POLICY "order_lines_tenant_isolation" ON "order_lines" AS PERMISSIVE FOR ALL TO "mezon_app" USING ("organization_id" = mezon_current_organization_id()) WITH CHECK ("organization_id" = mezon_current_organization_id());
--> statement-breakpoint
REVOKE ALL ON TABLE "order_lines" FROM "mezon_app";
--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE "order_lines" TO "mezon_app";

--> statement-breakpoint
ALTER TABLE "order_payments" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "order_payments" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "order_payments_tenant_isolation" ON "order_payments";
--> statement-breakpoint
CREATE POLICY "order_payments_tenant_isolation" ON "order_payments" AS PERMISSIVE FOR ALL TO "mezon_app" USING ("organization_id" = mezon_current_organization_id()) WITH CHECK ("organization_id" = mezon_current_organization_id());
--> statement-breakpoint
REVOKE ALL ON TABLE "order_payments" FROM "mezon_app";
--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE "order_payments" TO "mezon_app";

--> statement-breakpoint
ALTER TABLE "cloud_store_sync_positions" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
REVOKE ALL ON TABLE "cloud_store_sync_positions" FROM mezon_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON TABLE "cloud_store_sync_positions" TO mezon_app;

--> statement-breakpoint
ALTER TABLE "cloud_sync_parked" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
REVOKE ALL ON TABLE "cloud_sync_parked" FROM mezon_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON TABLE "cloud_sync_parked" TO mezon_app;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION sync_check_cross_tenant_entity(
  p_entity text,
  p_entity_id uuid,
  p_org_id uuid
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  RETURN EXISTS (
    SELECT 1 FROM public.cloud_sync_events
    WHERE entity = p_entity
      AND entity_id = p_entity_id
      AND organization_id <> p_org_id
  );
END;
$$;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION sync_check_cross_tenant_entity(text, uuid, uuid) TO mezon_app;
