CREATE TABLE `viewer_devices` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`device_id` text NOT NULL,
	`name` text NOT NULL,
	`key_encrypted` text NOT NULL,
	`folder` text NOT NULL,
	`paired_at` text NOT NULL,
	`revoked_at` text,
	`last_written_at` text,
	`last_error` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `viewer_devices_device_id_unique` ON `viewer_devices` (`device_id`);