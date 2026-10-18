ALTER TABLE `budgets` ADD `rollover` text DEFAULT 'off' NOT NULL;--> statement-breakpoint
ALTER TABLE `budgets` ADD `fund_target_minor` integer;--> statement-breakpoint
ALTER TABLE `budgets` ADD `fund_target_date` text;