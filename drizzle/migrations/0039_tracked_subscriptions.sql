CREATE TABLE `tracked_subscriptions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`amount_minor` integer NOT NULL,
	`billing` text NOT NULL,
	`frequency` text,
	`repeat_every` integer DEFAULT 1 NOT NULL,
	`start_date` text NOT NULL,
	`term_months` integer,
	`account_id` integer,
	`category_id` integer,
	`email` text,
	`username` text,
	`website` text,
	`notes` text,
	`status` text DEFAULT 'active' NOT NULL,
	`cancelled_on` text,
	`recurring_key` text,
	`planned_id` integer,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`category_id`) REFERENCES `categories`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`planned_id`) REFERENCES `planned_transactions`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `tracked_subscriptions_recurring_key_unique` ON `tracked_subscriptions` (`recurring_key`);