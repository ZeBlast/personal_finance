ALTER TABLE `transactions` ADD `refund_source` text;--> statement-breakpoint
ALTER TABLE `transactions` ADD `refund_blocked` integer DEFAULT false NOT NULL;--> statement-breakpoint
-- Refunds linked before detection existed were linked by the user.
UPDATE `transactions` SET `refund_source` = 'manual' WHERE `refund_of_id` IS NOT NULL;
