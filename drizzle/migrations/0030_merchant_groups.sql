CREATE TABLE `merchant_group_members` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`group_id` integer NOT NULL,
	`merchant_key` text NOT NULL,
	`merchant_name` text NOT NULL,
	FOREIGN KEY (`group_id`) REFERENCES `merchant_groups`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `merchant_group_members_key` ON `merchant_group_members` (`merchant_key`);--> statement-breakpoint
CREATE TABLE `merchant_groups` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
