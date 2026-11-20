DROP INDEX `uidx_shifts_one_open_per_device`;--> statement-breakpoint
ALTER TABLE `shifts` ADD `register_id` text;--> statement-breakpoint
CREATE UNIQUE INDEX `uidx_shifts_one_open_per_device` ON `shifts` (`organization_id`,`store_id`,`device_id`,(CASE WHEN "register_id" IS NULL THEN '' ELSE CAST("register_id" AS text) END)) WHERE "shifts"."status" = 'open';--> statement-breakpoint
ALTER TABLE `cash_moves` ADD `register_id` text;--> statement-breakpoint
ALTER TABLE `shift_cashier_sessions` ADD `register_id` text;