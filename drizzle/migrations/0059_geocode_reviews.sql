CREATE TABLE `geocode_reviews` (
	`query_key` text PRIMARY KEY NOT NULL,
	`verdict` text NOT NULL,
	`lat` real NOT NULL,
	`lon` real NOT NULL,
	`reviewed_at` text NOT NULL
);
