-- Transactions the app added as the other side of a transfer linked by hand take their partner's
-- dates, so they list right after it.
UPDATE `transactions` SET
  `date` = (SELECT o.`date` FROM `transactions` o WHERE o.`id` = `transactions`.`transfer_pair_id`),
  `authorized_date` = (SELECT o.`authorized_date` FROM `transactions` o WHERE o.`id` = `transactions`.`transfer_pair_id`)
WHERE `created_for_transfer` = 1
  AND `transfer_pair_id` IN (SELECT `id` FROM `transactions`);
