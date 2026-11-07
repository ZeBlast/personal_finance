-- A card's closing and due days are one fact. Cards whose bill was set on Card bills give the same
-- days to their statements (Card bills' days drive the forecast, so they win where the two differ).
UPDATE `accounts` SET
  `statement_closing_day` = (SELECT b.`closing_day` FROM `card_bills` b WHERE b.`account_id` = `accounts`.`id`),
  `statement_due_day` = (SELECT b.`due_day` FROM `card_bills` b WHERE b.`account_id` = `accounts`.`id`)
WHERE `id` IN (SELECT `account_id` FROM `card_bills`);
