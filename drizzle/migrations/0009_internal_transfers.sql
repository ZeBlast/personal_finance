ALTER TABLE `transactions` ADD `transfer_source` text;--> statement-breakpoint
ALTER TABLE `transactions` ADD `transfer_pair_id` integer;--> statement-breakpoint
UPDATE `transactions` SET `transfer_source` = 'system' WHERE `source` = 'manual' AND `is_transfer` = 1 AND `name` = 'Opening balance';
--> statement-breakpoint
UPDATE `transactions` SET `transfer_source` = 'manual' WHERE `source` = 'manual' AND `is_transfer` = 1 AND `transfer_source` IS NULL;
--> statement-breakpoint
-- Bank transactions were flagged by the old rule (any transfer category, or a person named). Only matched transfers between own accounts count now, and the app finds them at launch.
UPDATE `transactions` SET `is_transfer` = 0 WHERE `source` <> 'manual';
