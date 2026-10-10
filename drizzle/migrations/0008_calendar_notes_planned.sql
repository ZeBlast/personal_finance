CREATE TABLE `day_notes` (
	`date` text PRIMARY KEY NOT NULL,
	`note` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `planned_exceptions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`planned_id` integer NOT NULL,
	`date` text NOT NULL,
	`kind` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`planned_id`) REFERENCES `planned_transactions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `planned_exceptions_unique` ON `planned_exceptions` (`planned_id`,`date`);--> statement-breakpoint
CREATE TABLE `planned_transactions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`account_id` integer,
	`merchant` text NOT NULL,
	`amount_minor` integer NOT NULL,
	`category_id` integer,
	`person` text,
	`notes` text,
	`start_date` text NOT NULL,
	`frequency` text NOT NULL,
	`repeat_every` integer DEFAULT 1 NOT NULL,
	`weekdays` text,
	`month_mode` text,
	`day_of_month` integer,
	`nth_week` integer,
	`end_date` text,
	`max_count` integer,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`category_id`) REFERENCES `categories`(`id`) ON UPDATE no action ON DELETE set null
);
