CREATE TABLE `payment_intents` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`store_id` text NOT NULL,
	`created_at_ms` integer NOT NULL,
	`updated_at_ms` integer NOT NULL,
	`cart_id` text,
	`method` text NOT NULL,
	`kind` text NOT NULL,
	`amount` integer NOT NULL,
	`status` text NOT NULL,
	`provider_ref` text NOT NULL,
	`qr_payload` text,
	`expires_at_ms` integer NOT NULL,
	`paid_at_ms` integer,
	`paid_late` integer DEFAULT false NOT NULL,
	`confirmed_by_user_id` text,
	`confirm_note` text,
	`consumed_by_sale_id` text,
	`refunded_at_ms` integer,
	FOREIGN KEY (`consumed_by_sale_id`) REFERENCES `sales`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "chk_payment_intents_created_at_ms_int" CHECK(typeof("payment_intents"."created_at_ms") = 'integer'),
	CONSTRAINT "chk_payment_intents_updated_at_ms_int" CHECK(typeof("payment_intents"."updated_at_ms") = 'integer'),
	CONSTRAINT "chk_payment_intents_amount_int" CHECK(typeof("payment_intents"."amount") = 'integer'),
	CONSTRAINT "chk_payment_intents_expires_at_ms_int" CHECK(typeof("payment_intents"."expires_at_ms") = 'integer'),
	CONSTRAINT "chk_payment_intents_paid_at_ms_int" CHECK("payment_intents"."paid_at_ms" IS NULL OR typeof("payment_intents"."paid_at_ms") = 'integer'),
	CONSTRAINT "chk_payment_intents_refunded_at_ms_int" CHECK("payment_intents"."refunded_at_ms" IS NULL OR typeof("payment_intents"."refunded_at_ms") = 'integer'),
	CONSTRAINT "chk_payment_intents_method" CHECK("payment_intents"."method" IN ('uzqr')),
	CONSTRAINT "chk_payment_intents_kind" CHECK("payment_intents"."kind" IN ('dynamic', 'static')),
	CONSTRAINT "chk_payment_intents_status" CHECK("payment_intents"."status" IN ('pending', 'paid', 'expired', 'cancelled', 'failed', 'refunded')),
	CONSTRAINT "chk_payment_intents_amount" CHECK("payment_intents"."amount" > 0),
	CONSTRAINT "chk_payment_intents_paid_at" CHECK(("payment_intents"."status" IN ('paid', 'refunded')) = ("payment_intents"."paid_at_ms" IS NOT NULL)),
	CONSTRAINT "chk_payment_intents_consumed_paid" CHECK("payment_intents"."consumed_by_sale_id" IS NULL OR "payment_intents"."status" = 'paid')
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uidx_payment_intents_provider_ref` ON `payment_intents` (`organization_id`,`provider_ref`);--> statement-breakpoint
CREATE UNIQUE INDEX `uidx_payment_intents_consumed` ON `payment_intents` (`consumed_by_sale_id`) WHERE "payment_intents"."consumed_by_sale_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX `idx_payment_intents_cart` ON `payment_intents` (`cart_id`);