CREATE TABLE `account_yields` (
	`account_id` integer PRIMARY KEY NOT NULL,
	`apy_bps` integer NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE cascade
);
