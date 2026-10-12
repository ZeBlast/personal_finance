ALTER TABLE `transactions` ADD `refund_of_id` integer;--> statement-breakpoint
-- Totals read transaction_lines. A refund linked to the charge it gives back is placed on that
-- charge's date and (unless split) in its category, so it takes away from that spending; and the
-- link is exposed so a linked refund is never counted as income.
DROP VIEW IF EXISTS `transaction_lines`;--> statement-breakpoint
CREATE VIEW `transaction_lines` AS
SELECT t."id", t."account_id", t."plaid_transaction_id", t."pending_plaid_transaction_id",
  CASE WHEN t."refund_of_id" IS NULL THEN t."date"
    ELSE coalesce((SELECT o."date" FROM `transactions` o WHERE o."id" = t."refund_of_id"), t."date") END AS "date",
  CASE WHEN t."refund_of_id" IS NULL THEN t."authorized_date"
    ELSE coalesce((SELECT coalesce(o."authorized_date", o."date") FROM `transactions` o WHERE o."id" = t."refund_of_id"), t."authorized_date") END AS "authorized_date",
  t."name", t."merchant_name", t."currency", t."pending", t."payment_channel", t."plaid_category_primary", t."plaid_category_detailed", t."counterparty_name", t."counterparty_type", t."counterparties_json", t."datetime", t."authorized_datetime", t."original_description", t."location_address", t."location_city", t."location_region", t."location_postal_code", t."location_country", t."location_lat", t."location_lon", t."location_store_number", t."merchant_entity_id", t."merchant_category_code", t."logo_url", t."website", t."category_confidence", t."payment_method", t."payment_processor", t."payment_reference", t."payment_reason", t."payment_by_order_of", t."payment_ppd_id", t."recipient", t."recipient_source", t."sender", t."sender_source", t."source", t."is_transfer", t."transfer_source", t."transfer_pair_id", t."merchant_name_user", t."recipient_user", t."sender_user", t."notes_user", t."online_user", t."reviewed_at", t."category_source", t."category_rule_id", t."created_at", t."updated_at", t."amount_minor" AS "amount_minor",
  CASE WHEN t."refund_of_id" IS NULL THEN t."category_id"
    ELSE coalesce((SELECT o."category_id" FROM `transactions` o WHERE o."id" = t."refund_of_id"), t."category_id") END AS "category_id",
  NULL AS "split_id", t."refund_of_id"
FROM `transactions` t
WHERE coalesce(
  (SELECT sum(s."amount_minor") FROM `transaction_splits` s WHERE s."transaction_id" = t."id"),
  t."amount_minor" + 1
) <> t."amount_minor"
UNION ALL
SELECT t."id", t."account_id", t."plaid_transaction_id", t."pending_plaid_transaction_id",
  CASE WHEN t."refund_of_id" IS NULL THEN t."date"
    ELSE coalesce((SELECT o."date" FROM `transactions` o WHERE o."id" = t."refund_of_id"), t."date") END AS "date",
  CASE WHEN t."refund_of_id" IS NULL THEN t."authorized_date"
    ELSE coalesce((SELECT coalesce(o."authorized_date", o."date") FROM `transactions` o WHERE o."id" = t."refund_of_id"), t."authorized_date") END AS "authorized_date",
  t."name", t."merchant_name", t."currency", t."pending", t."payment_channel", t."plaid_category_primary", t."plaid_category_detailed", t."counterparty_name", t."counterparty_type", t."counterparties_json", t."datetime", t."authorized_datetime", t."original_description", t."location_address", t."location_city", t."location_region", t."location_postal_code", t."location_country", t."location_lat", t."location_lon", t."location_store_number", t."merchant_entity_id", t."merchant_category_code", t."logo_url", t."website", t."category_confidence", t."payment_method", t."payment_processor", t."payment_reference", t."payment_reason", t."payment_by_order_of", t."payment_ppd_id", t."recipient", t."recipient_source", t."sender", t."sender_source", t."source", t."is_transfer", t."transfer_source", t."transfer_pair_id", t."merchant_name_user", t."recipient_user", t."sender_user", t."notes_user", t."online_user", t."reviewed_at", t."category_source", t."category_rule_id", t."created_at", t."updated_at", s."amount_minor" AS "amount_minor", s."category_id" AS "category_id", s."id" AS "split_id", t."refund_of_id"
FROM `transactions` t JOIN `transaction_splits` s ON s."transaction_id" = t."id"
WHERE (SELECT sum(x."amount_minor") FROM `transaction_splits` x WHERE x."transaction_id" = t."id") = t."amount_minor";
