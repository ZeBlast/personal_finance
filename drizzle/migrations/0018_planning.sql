CREATE TABLE `attachments` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`transaction_id` integer NOT NULL,
	`name` text NOT NULL,
	`mime` text NOT NULL,
	`size` integer NOT NULL,
	`data` blob NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`transaction_id`) REFERENCES `transactions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `attachments_transaction_idx` ON `attachments` (`transaction_id`);--> statement-breakpoint
CREATE TABLE `card_bills` (
	`account_id` integer PRIMARY KEY NOT NULL,
	`closing_day` integer NOT NULL,
	`due_day` integer NOT NULL,
	`minimum_minor` integer,
	`autopay` integer DEFAULT false NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `duplicate_dismissals` (
	`pair_key` text PRIMARY KEY NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `subscription_reviews` (
	`key` text PRIMARY KEY NOT NULL,
	`merchant` text NOT NULL,
	`status` text NOT NULL,
	`note` text,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
ALTER TABLE `transactions` ADD `reviewed_at` text;