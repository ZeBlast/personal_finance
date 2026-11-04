CREATE TABLE `category_change_batches` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`kind` text NOT NULL,
	`rule_id` integer,
	`label` text NOT NULL,
	`change_count` integer NOT NULL,
	`created_at` text NOT NULL,
	`undone_at` text
);
--> statement-breakpoint
CREATE TABLE `category_change_items` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`batch_id` integer NOT NULL,
	`transaction_id` integer NOT NULL,
	`from_category_id` integer,
	`from_rule_id` integer,
	`from_source` text,
	`to_category_id` integer,
	`to_rule_id` integer,
	`to_source` text,
	FOREIGN KEY (`batch_id`) REFERENCES `category_change_batches`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`transaction_id`) REFERENCES `transactions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `category_change_items_batch_idx` ON `category_change_items` (`batch_id`);--> statement-breakpoint
ALTER TABLE `transaction_rules` ADD `applies_from` text;