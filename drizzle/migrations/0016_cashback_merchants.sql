ALTER TABLE `cashback_rules` ADD `merchant` text;--> statement-breakpoint
ALTER TABLE `cashback_rules` ADD `exclude` integer DEFAULT false NOT NULL;