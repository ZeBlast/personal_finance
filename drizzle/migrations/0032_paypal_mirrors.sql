ALTER TABLE `transactions` ADD `mirror_of_id` integer;--> statement-breakpoint
ALTER TABLE `transactions` ADD `mirror_source` text;--> statement-breakpoint
ALTER TABLE `transactions` ADD `mirror_blocked` integer DEFAULT false NOT NULL;