-- A purchase with reimbursements linked can be split by what was kept: its parts add up to the
-- purchase less what came back. Those parts are all it counts as, and the reimbursements
-- themselves (already taken off) count nowhere else in totals.
--
-- Until now such a purchase also stored a "Reimbursed" part for the amount that came back, and
-- each reimbursement a one-part split that gave it back. Those are removed here: the purchase keeps
-- only the parts the user chose, and each reimbursement keeps its own category, unsplit.
DELETE FROM `transaction_splits`
WHERE `transaction_id` IN (
  SELECT r.`id` FROM `transactions` r
  WHERE r.`refund_of_id` IN (
    SELECT s.`transaction_id` FROM `transaction_splits` s WHERE s.`note` = 'Reimbursed'
  )
);--> statement-breakpoint
DELETE FROM `transaction_splits`
WHERE `note` = 'Reimbursed'
  AND `transaction_id` IN (SELECT `refund_of_id` FROM `transactions` WHERE `refund_of_id` IS NOT NULL);--> statement-breakpoint
-- Totals read transaction_lines. A transaction counts by its split when the parts add up to it, or,
-- for a purchase with reimbursements, to what was kept (the purchase less what came back). A
-- reimbursement of a purchase split by what was kept is left out: it is already taken off. Any
-- other refund linked to a charge is placed on that charge's date and (unless split) in its
-- category, so it takes away from that spending.
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
WHERE coalesce((SELECT sum(s."amount_minor") FROM `transaction_splits` s WHERE s."transaction_id" = t."id"), t."amount_minor" + 1) <> t."amount_minor"
  -- Not split by what was kept.
  AND NOT (
    t."amount_minor" > 0
    AND coalesce((SELECT -sum(r."amount_minor") FROM `transactions` r WHERE r."refund_of_id" = t."id"), 0) > 0
    AND coalesce((SELECT sum(s."amount_minor") FROM `transaction_splits` s WHERE s."transaction_id" = t."id"), t."amount_minor" + 1)
      = t."amount_minor" - (SELECT -sum(r."amount_minor") FROM `transactions` r WHERE r."refund_of_id" = t."id")
  )
  -- Not a reimbursement of a purchase split by what was kept.
  AND NOT EXISTS (
    SELECT 1 FROM `transactions` o
    WHERE o."id" = t."refund_of_id" AND o."amount_minor" > 0
      AND (SELECT sum(s."amount_minor") FROM `transaction_splits` s WHERE s."transaction_id" = o."id")
        = o."amount_minor" - (SELECT -sum(r."amount_minor") FROM `transactions` r WHERE r."refund_of_id" = o."id")
      AND (SELECT -sum(r."amount_minor") FROM `transactions` r WHERE r."refund_of_id" = o."id") > 0
  )
UNION ALL
SELECT t."id", t."account_id", t."plaid_transaction_id", t."pending_plaid_transaction_id",
  CASE WHEN t."refund_of_id" IS NULL THEN t."date"
    ELSE coalesce((SELECT o."date" FROM `transactions` o WHERE o."id" = t."refund_of_id"), t."date") END AS "date",
  CASE WHEN t."refund_of_id" IS NULL THEN t."authorized_date"
    ELSE coalesce((SELECT coalesce(o."authorized_date", o."date") FROM `transactions` o WHERE o."id" = t."refund_of_id"), t."authorized_date") END AS "authorized_date",
  t."name", t."merchant_name", t."currency", t."pending", t."payment_channel", t."plaid_category_primary", t."plaid_category_detailed", t."counterparty_name", t."counterparty_type", t."counterparties_json", t."datetime", t."authorized_datetime", t."original_description", t."location_address", t."location_city", t."location_region", t."location_postal_code", t."location_country", t."location_lat", t."location_lon", t."location_store_number", t."merchant_entity_id", t."merchant_category_code", t."logo_url", t."website", t."category_confidence", t."payment_method", t."payment_processor", t."payment_reference", t."payment_reason", t."payment_by_order_of", t."payment_ppd_id", t."recipient", t."recipient_source", t."sender", t."sender_source", t."source", t."is_transfer", t."transfer_source", t."transfer_pair_id", t."merchant_name_user", t."recipient_user", t."sender_user", t."notes_user", t."online_user", t."reviewed_at", t."category_source", t."category_rule_id", t."created_at", t."updated_at", s."amount_minor" AS "amount_minor", s."category_id" AS "category_id", s."id" AS "split_id", t."refund_of_id"
FROM `transactions` t JOIN `transaction_splits` s ON s."transaction_id" = t."id"
WHERE (
    (SELECT sum(x."amount_minor") FROM `transaction_splits` x WHERE x."transaction_id" = t."id") = t."amount_minor"
    -- Or split by what was kept.
    OR (
      t."amount_minor" > 0
      AND coalesce((SELECT -sum(r."amount_minor") FROM `transactions` r WHERE r."refund_of_id" = t."id"), 0) > 0
      AND (SELECT sum(x."amount_minor") FROM `transaction_splits` x WHERE x."transaction_id" = t."id")
        = t."amount_minor" - (SELECT -sum(r."amount_minor") FROM `transactions` r WHERE r."refund_of_id" = t."id")
    )
  )
  -- Not a reimbursement of a purchase split by what was kept.
  AND NOT EXISTS (
    SELECT 1 FROM `transactions` o
    WHERE o."id" = t."refund_of_id" AND o."amount_minor" > 0
      AND (SELECT sum(x."amount_minor") FROM `transaction_splits` x WHERE x."transaction_id" = o."id")
        = o."amount_minor" - (SELECT -sum(r."amount_minor") FROM `transactions` r WHERE r."refund_of_id" = o."id")
      AND (SELECT -sum(r."amount_minor") FROM `transactions` r WHERE r."refund_of_id" = o."id") > 0
  );
