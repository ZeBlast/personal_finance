CREATE TABLE `goals` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`target_minor` integer NOT NULL,
	`target_date` text,
	`saved_minor` integer DEFAULT 0 NOT NULL,
	`account_ids` text DEFAULT '[]' NOT NULL,
	`color` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
