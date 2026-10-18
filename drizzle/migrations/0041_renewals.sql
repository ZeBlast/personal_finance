CREATE TABLE `renewal_dismissals` (
	`key` text PRIMARY KEY NOT NULL,
	`dismissed_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `subscription_payment_exclusions` (
	`subscription_id` integer NOT NULL,
	`transaction_id` integer NOT NULL,
	FOREIGN KEY (`subscription_id`) REFERENCES `tracked_subscriptions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`transaction_id`) REFERENCES `transactions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `subscription_payment_exclusions_unique` ON `subscription_payment_exclusions` (`subscription_id`,`transaction_id`);--> statement-breakpoint
ALTER TABLE `tracked_subscriptions` ADD `trial_ends_on` text;--> statement-breakpoint
ALTER TABLE `tracked_subscriptions` ADD `payment_match` text;