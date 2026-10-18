CREATE TABLE `tags` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`color` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `tags_name_unique` ON `tags` (`name`);--> statement-breakpoint
CREATE TABLE `transaction_tags` (
	`transaction_id` integer NOT NULL,
	`tag_id` integer NOT NULL,
	FOREIGN KEY (`transaction_id`) REFERENCES `transactions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`tag_id`) REFERENCES `tags`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `transaction_tags_unique` ON `transaction_tags` (`transaction_id`,`tag_id`);--> statement-breakpoint
CREATE INDEX `transaction_tags_tag_idx` ON `transaction_tags` (`tag_id`);