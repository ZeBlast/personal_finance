CREATE TABLE `accounts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`plaid_item_id` integer,
	`plaid_account_id` text,
	`name` text NOT NULL,
	`official_name` text,
	`type` text NOT NULL,
	`subtype` text,
	`mask` text,
	`currency` text DEFAULT 'USD' NOT NULL,
	`current_balance_minor` integer,
	`available_balance_minor` integer,
	`last_balance_update_at` text,
	`is_manual` integer DEFAULT false NOT NULL,
	`source` text DEFAULT 'plaid' NOT NULL,
	`color` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`plaid_item_id`) REFERENCES `plaid_items`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `accounts_plaid_account_id_unique` ON `accounts` (`plaid_account_id`);--> statement-breakpoint
CREATE INDEX `accounts_plaid_item_idx` ON `accounts` (`plaid_item_id`);--> statement-breakpoint
CREATE TABLE `credentials` (
	`key` text PRIMARY KEY NOT NULL,
	`value_encrypted` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `plaid_items` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`plaid_item_id` text NOT NULL,
	`environment` text NOT NULL,
	`institution_id` text,
	`institution_name` text NOT NULL,
	`access_token_encrypted` text NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`last_error_code` text,
	`last_error_message` text,
	`days_requested` integer NOT NULL,
	`sync_cursor` text,
	`last_successful_sync_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `plaid_items_plaid_item_id_unique` ON `plaid_items` (`plaid_item_id`);