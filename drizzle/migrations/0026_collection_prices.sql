CREATE TABLE `collection_price_history` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`item_id` integer NOT NULL,
	`day` text NOT NULL,
	`price_minor` integer NOT NULL,
	FOREIGN KEY (`item_id`) REFERENCES `collection_items`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `collection_price_history_item_day` ON `collection_price_history` (`item_id`,`day`);--> statement-breakpoint
ALTER TABLE `collection_items` ADD `value_source` text;--> statement-breakpoint
ALTER TABLE `collection_items` ADD `price_variant_id` text;--> statement-breakpoint
ALTER TABLE `collection_items` ADD `price_match_label` text;--> statement-breakpoint
ALTER TABLE `collection_items` ADD `price_match_status` text;--> statement-breakpoint
ALTER TABLE `collection_items` ADD `market_price_minor` integer;--> statement-breakpoint
ALTER TABLE `collection_items` ADD `price_updated_at` text;