-- Collections made from a TCGPlayer export (cards with set codes) are Pokemon card collections,
-- the type that has TCGplayer ids, conditions and market prices.
UPDATE `accounts` SET `subtype` = 'pokemon cards'
WHERE `is_manual` = 1 AND `subtype` = 'collection'
  AND `id` IN (SELECT DISTINCT `account_id` FROM `collection_items` WHERE `tcgplayer_id` IS NOT NULL OR `set_code` <> '');
--> statement-breakpoint
-- Their cards are Lightly Played unless they say otherwise.
UPDATE `collection_items` SET `condition` = 'LP'
WHERE (`condition` IS NULL OR `condition` = '')
  AND `account_id` IN (SELECT `id` FROM `accounts` WHERE `subtype` = 'pokemon cards');
