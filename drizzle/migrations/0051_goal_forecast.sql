ALTER TABLE `goals` ADD `forecast_monthly_minor` integer;--> statement-breakpoint
ALTER TABLE `goals` ADD `forecast_day` integer DEFAULT 1 NOT NULL;