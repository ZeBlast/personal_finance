CREATE TABLE `reconciliations` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`account_id` integer NOT NULL,
	`statement_date` text NOT NULL,
	`statement_balance_minor` integer NOT NULL,
	`app_balance_minor` integer NOT NULL,
	`status` text NOT NULL,
	`note` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `reconciliations_account_idx` ON `reconciliations` (`account_id`,`statement_date`);