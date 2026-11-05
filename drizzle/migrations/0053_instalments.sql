CREATE TABLE `instalment_purchases` (
	`transaction_id` integer PRIMARY KEY NOT NULL,
	`instalments` integer DEFAULT 4 NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`transaction_id`) REFERENCES `transactions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
ALTER TABLE `transactions` ADD `instalment_of_id` integer;--> statement-breakpoint
ALTER TABLE `transactions` ADD `instalment_prior_transfer` integer;--> statement-breakpoint
ALTER TABLE `transactions` ADD `instalment_prior_source` text;--> statement-breakpoint
CREATE INDEX `transactions_instalment_of_idx` ON `transactions` (`instalment_of_id`);