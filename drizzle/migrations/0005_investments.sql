CREATE TABLE `holding_snapshots` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`account_id` integer NOT NULL,
	`security_id` integer NOT NULL,
	`observed_at` text NOT NULL,
	`quantity` real NOT NULL,
	`value_minor` integer NOT NULL,
	`cost_basis_minor` integer,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`security_id`) REFERENCES `securities`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE INDEX `holding_snapshots_account_idx` ON `holding_snapshots` (`account_id`,`observed_at`);--> statement-breakpoint
CREATE TABLE `holdings` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`account_id` integer NOT NULL,
	`security_id` integer NOT NULL,
	`quantity` real NOT NULL,
	`price` real,
	`value_minor` integer NOT NULL,
	`cost_basis_minor` integer,
	`currency` text NOT NULL,
	`as_of` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`security_id`) REFERENCES `securities`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE UNIQUE INDEX `holdings_account_security_unique` ON `holdings` (`account_id`,`security_id`);--> statement-breakpoint
CREATE TABLE `investment_transactions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`account_id` integer NOT NULL,
	`security_id` integer,
	`plaid_investment_transaction_id` text,
	`import_key` text,
	`date` text NOT NULL,
	`type` text NOT NULL,
	`name` text NOT NULL,
	`quantity` real,
	`price` real,
	`amount_minor` integer NOT NULL,
	`fees_minor` integer,
	`currency` text NOT NULL,
	`source` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`security_id`) REFERENCES `securities`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `investment_transactions_plaid_investment_transaction_id_unique` ON `investment_transactions` (`plaid_investment_transaction_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `investment_transactions_import_key_unique` ON `investment_transactions` (`import_key`);--> statement-breakpoint
CREATE INDEX `investment_tx_account_date_idx` ON `investment_transactions` (`account_id`,`date`);--> statement-breakpoint
CREATE TABLE `securities` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`plaid_security_id` text,
	`manual_key` text,
	`symbol` text,
	`name` text NOT NULL,
	`security_type` text,
	`asset_class` text NOT NULL,
	`currency` text DEFAULT 'USD' NOT NULL,
	`is_manual` integer DEFAULT false NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `securities_plaid_security_id_unique` ON `securities` (`plaid_security_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `securities_manual_key_unique` ON `securities` (`manual_key`);