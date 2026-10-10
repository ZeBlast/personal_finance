CREATE TABLE `fund_prices` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`symbol` text NOT NULL,
	`date` text NOT NULL,
	`price` real NOT NULL,
	`source` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `fund_prices_symbol_date_unique` ON `fund_prices` (`symbol`,`date`);--> statement-breakpoint
CREATE TABLE `tsp_allocations` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`account_id` integer NOT NULL,
	`symbol` text NOT NULL,
	`percent_bps` integer NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `tsp_allocations_account_symbol_unique` ON `tsp_allocations` (`account_id`,`symbol`);--> statement-breakpoint
CREATE TABLE `tsp_contribution_applications` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`contribution_id` integer NOT NULL,
	`date` text NOT NULL,
	`symbol` text NOT NULL,
	`price_date` text NOT NULL,
	`price` real NOT NULL,
	`units` real NOT NULL,
	`amount_minor` integer NOT NULL,
	`applied_at` text NOT NULL,
	FOREIGN KEY (`contribution_id`) REFERENCES `tsp_contributions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `tsp_applications_unique` ON `tsp_contribution_applications` (`contribution_id`,`date`,`symbol`);--> statement-breakpoint
CREATE TABLE `tsp_contributions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`account_id` integer NOT NULL,
	`amount_minor` integer NOT NULL,
	`frequency` text NOT NULL,
	`start_date` text NOT NULL,
	`end_date` text,
	`day_of_month` integer,
	`second_day_of_month` integer,
	`active` integer DEFAULT true NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE cascade
);
