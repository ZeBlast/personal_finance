CREATE TABLE `categories` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`parent_id` integer,
	`color` text,
	`active` integer DEFAULT true NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`parent_id`) REFERENCES `categories`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `categories_parent_idx` ON `categories` (`parent_id`);--> statement-breakpoint
CREATE TABLE `transaction_rules` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`field` text NOT NULL,
	`operator` text NOT NULL,
	`match_value` text NOT NULL,
	`category_id` integer NOT NULL,
	`priority` integer NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`category_id`) REFERENCES `categories`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
ALTER TABLE `transactions` ADD `category_id` integer REFERENCES categories(id);--> statement-breakpoint
ALTER TABLE `transactions` ADD `category_source` text;--> statement-breakpoint
ALTER TABLE `transactions` ADD `category_rule_id` integer REFERENCES transaction_rules(id);--> statement-breakpoint
CREATE INDEX `transactions_category_idx` ON `transactions` (`category_id`);