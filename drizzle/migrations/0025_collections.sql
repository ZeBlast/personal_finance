CREATE TABLE `collection_items` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`account_id` integer NOT NULL,
	`item_key` text NOT NULL,
	`name` text NOT NULL,
	`variant` text DEFAULT '' NOT NULL,
	`set_code` text DEFAULT '' NOT NULL,
	`number` text DEFAULT '' NOT NULL,
	`quantity` integer DEFAULT 1 NOT NULL,
	`unit_value_minor` integer,
	`unit_cost_minor` integer,
	`condition` text,
	`notes` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `collection_items_account_key` ON `collection_items` (`account_id`,`item_key`);