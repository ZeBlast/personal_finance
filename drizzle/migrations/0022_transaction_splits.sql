CREATE TABLE `transaction_splits` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`transaction_id` integer NOT NULL,
	`category_id` integer,
	`amount_minor` integer NOT NULL,
	`note` text,
	`position` integer DEFAULT 0 NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`transaction_id`) REFERENCES `transactions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`category_id`) REFERENCES `categories`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `transaction_splits_transaction_idx` ON `transaction_splits` (`transaction_id`);--> statement-breakpoint
-- Each transaction as the lines totals count: a split transaction (one whose parts still add up to
-- its amount) is one line per part, with that part's category and amount; any other transaction
-- is itself. Charts, budgets, and the calendar read this instead of transactions.
CREATE VIEW `transaction_lines` AS
SELECT t."id", t."account_id", t."plaid_transaction_id", t."pending_plaid_transaction_id", t."date", t."authorized_date", t."name", t."merchant_name", t."currency", t."pending", t."payment_channel", t."plaid_category_primary", t."plaid_category_detailed", t."counterparty_name", t."counterparty_type", t."counterparties_json", t."datetime", t."authorized_datetime", t."original_description", t."location_address", t."location_city", t."location_region", t."location_postal_code", t."location_country", t."location_lat", t."location_lon", t."location_store_number", t."merchant_entity_id", t."merchant_category_code", t."logo_url", t."website", t."category_confidence", t."payment_method", t."payment_processor", t."payment_reference", t."payment_reason", t."payment_by_order_of", t."payment_ppd_id", t."recipient", t."recipient_source", t."sender", t."sender_source", t."source", t."is_transfer", t."transfer_source", t."transfer_pair_id", t."merchant_name_user", t."recipient_user", t."sender_user", t."notes_user", t."online_user", t."reviewed_at", t."category_source", t."category_rule_id", t."created_at", t."updated_at", t."amount_minor" AS "amount_minor", t."category_id" AS "category_id", NULL AS "split_id"
FROM `transactions` t
WHERE coalesce(
  (SELECT sum(s."amount_minor") FROM `transaction_splits` s WHERE s."transaction_id" = t."id"),
  t."amount_minor" + 1
) <> t."amount_minor"
UNION ALL
SELECT t."id", t."account_id", t."plaid_transaction_id", t."pending_plaid_transaction_id", t."date", t."authorized_date", t."name", t."merchant_name", t."currency", t."pending", t."payment_channel", t."plaid_category_primary", t."plaid_category_detailed", t."counterparty_name", t."counterparty_type", t."counterparties_json", t."datetime", t."authorized_datetime", t."original_description", t."location_address", t."location_city", t."location_region", t."location_postal_code", t."location_country", t."location_lat", t."location_lon", t."location_store_number", t."merchant_entity_id", t."merchant_category_code", t."logo_url", t."website", t."category_confidence", t."payment_method", t."payment_processor", t."payment_reference", t."payment_reason", t."payment_by_order_of", t."payment_ppd_id", t."recipient", t."recipient_source", t."sender", t."sender_source", t."source", t."is_transfer", t."transfer_source", t."transfer_pair_id", t."merchant_name_user", t."recipient_user", t."sender_user", t."notes_user", t."online_user", t."reviewed_at", t."category_source", t."category_rule_id", t."created_at", t."updated_at", s."amount_minor" AS "amount_minor", s."category_id" AS "category_id", s."id" AS "split_id"
FROM `transactions` t JOIN `transaction_splits` s ON s."transaction_id" = t."id"
WHERE (SELECT sum(x."amount_minor") FROM `transaction_splits` x WHERE x."transaction_id" = t."id") = t."amount_minor";
