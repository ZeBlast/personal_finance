ALTER TABLE `transactions` ADD `counterparties_json` text;--> statement-breakpoint
ALTER TABLE `transactions` ADD `datetime` text;--> statement-breakpoint
ALTER TABLE `transactions` ADD `authorized_datetime` text;--> statement-breakpoint
ALTER TABLE `transactions` ADD `original_description` text;--> statement-breakpoint
ALTER TABLE `transactions` ADD `location_address` text;--> statement-breakpoint
ALTER TABLE `transactions` ADD `location_city` text;--> statement-breakpoint
ALTER TABLE `transactions` ADD `location_region` text;--> statement-breakpoint
ALTER TABLE `transactions` ADD `location_postal_code` text;--> statement-breakpoint
ALTER TABLE `transactions` ADD `location_country` text;--> statement-breakpoint
ALTER TABLE `transactions` ADD `location_lat` real;--> statement-breakpoint
ALTER TABLE `transactions` ADD `location_lon` real;--> statement-breakpoint
ALTER TABLE `transactions` ADD `location_store_number` text;--> statement-breakpoint
ALTER TABLE `transactions` ADD `merchant_entity_id` text;--> statement-breakpoint
ALTER TABLE `transactions` ADD `merchant_category_code` text;--> statement-breakpoint
ALTER TABLE `transactions` ADD `logo_url` text;--> statement-breakpoint
ALTER TABLE `transactions` ADD `website` text;--> statement-breakpoint
ALTER TABLE `transactions` ADD `category_confidence` text;--> statement-breakpoint
ALTER TABLE `transactions` ADD `payment_method` text;--> statement-breakpoint
ALTER TABLE `transactions` ADD `payment_processor` text;--> statement-breakpoint
ALTER TABLE `transactions` ADD `payment_reference` text;--> statement-breakpoint
ALTER TABLE `transactions` ADD `payment_reason` text;--> statement-breakpoint
ALTER TABLE `transactions` ADD `payment_by_order_of` text;--> statement-breakpoint
ALTER TABLE `transactions` ADD `payment_ppd_id` text;--> statement-breakpoint
-- Start every connection over from the beginning at its next sync, so the new fields are filled in for
-- transactions already stored. Stored transactions are matched by ID and updated in place; anything
-- you edited or categorized by hand is kept.
UPDATE `plaid_items` SET `sync_cursor` = NULL;
