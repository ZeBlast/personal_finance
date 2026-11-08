CREATE TABLE `geocode_cache` (
	`address_key` text PRIMARY KEY NOT NULL,
	`lat` real,
	`lon` real,
	`matched` text,
	`server` text NOT NULL,
	`looked_up_at` text NOT NULL
);
