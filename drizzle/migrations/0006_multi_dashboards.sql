CREATE TABLE `dashboards` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`initialized` integer DEFAULT false NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `recurring_dismissed` (
	`key` text PRIMARY KEY NOT NULL,
	`merchant` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
ALTER TABLE `dashboard_widgets` ADD `dashboard_id` integer DEFAULT 1 NOT NULL;--> statement-breakpoint
CREATE INDEX `dashboard_widgets_dashboard_idx` ON `dashboard_widgets` (`dashboard_id`);--> statement-breakpoint
-- The dashboard that already exists becomes dashboard 1 ("Main"), keeping its "already set up" state.
INSERT INTO `dashboards` (`id`, `name`, `initialized`, `created_at`, `updated_at`)
VALUES (1, 'Main', (SELECT COUNT(*) > 0 FROM `app_settings` WHERE `key` = 'dashboard_initialized'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
--> statement-breakpoint
DELETE FROM `app_settings` WHERE `key` = 'dashboard_initialized';
