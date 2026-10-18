CREATE TABLE `debt_terms` (
	`account_id` integer PRIMARY KEY NOT NULL,
	`apr_bps` integer NOT NULL,
	`minimum_minor` integer,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE cascade
);
