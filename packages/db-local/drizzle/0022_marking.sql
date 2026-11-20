CREATE TABLE `local_cart_marks` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`store_id` text NOT NULL,
	`created_at_ms` integer NOT NULL,
	`updated_at_ms` integer NOT NULL,
	`cart_id` text NOT NULL,
	`cart_line_id` text NOT NULL,
	`product_id` text NOT NULL,
	`code_key` text NOT NULL,
	`gtin` text NOT NULL,
	`serial` text NOT NULL,
	`code` text NOT NULL,
	`check_status` text NOT NULL,
	FOREIGN KEY (`cart_id`) REFERENCES `local_carts`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "chk_local_cart_marks_created_at_ms_int" CHECK(typeof("local_cart_marks"."created_at_ms") = 'integer'),
	CONSTRAINT "chk_local_cart_marks_updated_at_ms_int" CHECK(typeof("local_cart_marks"."updated_at_ms") = 'integer'),
	CONSTRAINT "chk_local_cart_marks_status" CHECK("local_cart_marks"."check_status" IN ('ok', 'unchecked'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uidx_local_cart_marks_code` ON `local_cart_marks` (`organization_id`,`code_key`);--> statement-breakpoint
CREATE INDEX `idx_local_cart_marks_line` ON `local_cart_marks` (`cart_id`,`cart_line_id`);--> statement-breakpoint
CREATE TABLE `local_sale_marks` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`store_id` text NOT NULL,
	`created_at_ms` integer NOT NULL,
	`updated_at_ms` integer NOT NULL,
	`sale_id` text NOT NULL,
	`sale_line_id` text NOT NULL,
	`product_id` text NOT NULL,
	`code_key` text NOT NULL,
	`gtin` text NOT NULL,
	`serial` text NOT NULL,
	`code` text NOT NULL,
	`check_status` text NOT NULL,
	`released_at_ms` integer,
	`released_reason` text,
	`release_source_id` text,
	FOREIGN KEY (`sale_id`) REFERENCES `sales`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "chk_local_sale_marks_created_at_ms_int" CHECK(typeof("local_sale_marks"."created_at_ms") = 'integer'),
	CONSTRAINT "chk_local_sale_marks_updated_at_ms_int" CHECK(typeof("local_sale_marks"."updated_at_ms") = 'integer'),
	CONSTRAINT "chk_local_sale_marks_released_at_ms_int" CHECK("local_sale_marks"."released_at_ms" IS NULL OR typeof("local_sale_marks"."released_at_ms") = 'integer'),
	CONSTRAINT "chk_local_sale_marks_status" CHECK("local_sale_marks"."check_status" IN ('ok', 'unchecked')),
	CONSTRAINT "chk_local_sale_marks_release" CHECK(("local_sale_marks"."released_at_ms" IS NULL) = ("local_sale_marks"."released_reason" IS NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uidx_local_sale_marks_active_code` ON `local_sale_marks` (`organization_id`,`code_key`) WHERE "local_sale_marks"."released_at_ms" IS NULL;--> statement-breakpoint
CREATE INDEX `idx_local_sale_marks_sale` ON `local_sale_marks` (`sale_id`,`sale_line_id`);--> statement-breakpoint
ALTER TABLE `local_hub_config` ADD `marking_mxik_prefixes_json` text DEFAULT '[]' NOT NULL;