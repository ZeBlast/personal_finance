CREATE TABLE `budgets` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`category_id` integer NOT NULL,
	`period_start` text NOT NULL,
	`amount_minor` integer NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`category_id`) REFERENCES `categories`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `budgets_category_period_unique` ON `budgets` (`category_id`,`period_start`);--> statement-breakpoint
CREATE TABLE `dashboard_widgets` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`widget_type` text NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`x` integer NOT NULL,
	`y` integer NOT NULL,
	`w` integer NOT NULL,
	`h` integer NOT NULL,
	`config` text DEFAULT '{}' NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
