CREATE TABLE `balance_snapshots` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`account_id` integer NOT NULL,
	`observed_at` text NOT NULL,
	`current_balance_minor` integer,
	`available_balance_minor` integer,
	`currency` text NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `balance_snapshots_account_idx` ON `balance_snapshots` (`account_id`,`observed_at`);--> statement-breakpoint
CREATE TABLE `credit_limit_history` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`account_id` integer NOT NULL,
	`limit_minor` integer NOT NULL,
	`currency` text NOT NULL,
	`effective_date` text NOT NULL,
	`source` text NOT NULL,
	`note` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `credit_limit_account_idx` ON `credit_limit_history` (`account_id`,`effective_date`);--> statement-breakpoint
CREATE TABLE `sync_runs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`plaid_item_id` integer NOT NULL,
	`trigger` text NOT NULL,
	`status` text NOT NULL,
	`started_at` text NOT NULL,
	`finished_at` text,
	`added_count` integer DEFAULT 0 NOT NULL,
	`modified_count` integer DEFAULT 0 NOT NULL,
	`removed_count` integer DEFAULT 0 NOT NULL,
	`error_code` text,
	`error_message` text,
	FOREIGN KEY (`plaid_item_id`) REFERENCES `plaid_items`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `sync_runs_item_idx` ON `sync_runs` (`plaid_item_id`,`id`);--> statement-breakpoint
CREATE TABLE `transactions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`account_id` integer NOT NULL,
	`plaid_transaction_id` text,
	`pending_plaid_transaction_id` text,
	`date` text NOT NULL,
	`authorized_date` text,
	`name` text NOT NULL,
	`merchant_name` text,
	`amount_minor` integer NOT NULL,
	`currency` text DEFAULT 'USD' NOT NULL,
	`pending` integer DEFAULT false NOT NULL,
	`payment_channel` text,
	`plaid_category_primary` text,
	`plaid_category_detailed` text,
	`counterparty_name` text,
	`counterparty_type` text,
	`recipient` text,
	`recipient_source` text,
	`is_transfer` integer DEFAULT false NOT NULL,
	`merchant_name_user` text,
	`recipient_user` text,
	`notes_user` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `transactions_plaid_transaction_id_unique` ON `transactions` (`plaid_transaction_id`);--> statement-breakpoint
CREATE INDEX `transactions_date_idx` ON `transactions` (`date`);--> statement-breakpoint
CREATE INDEX `transactions_account_date_idx` ON `transactions` (`account_id`,`date`);--> statement-breakpoint
CREATE INDEX `transactions_pending_id_idx` ON `transactions` (`pending_plaid_transaction_id`);