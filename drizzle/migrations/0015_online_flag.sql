ALTER TABLE `cashback_rules` ADD `online_only` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `transactions` ADD `online_user` integer;