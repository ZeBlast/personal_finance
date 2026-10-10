ALTER TABLE `holdings` ADD `vested_quantity` real;--> statement-breakpoint
ALTER TABLE `holdings` ADD `vested_value_minor` integer;--> statement-breakpoint
ALTER TABLE `holdings` ADD `price_as_of` text;--> statement-breakpoint
ALTER TABLE `holdings` ADD `price_datetime` text;--> statement-breakpoint
ALTER TABLE `holdings` ADD `raw_json` text;--> statement-breakpoint
ALTER TABLE `investment_transactions` ADD `subtype` text;--> statement-breakpoint
ALTER TABLE `investment_transactions` ADD `transaction_datetime` text;--> statement-breakpoint
ALTER TABLE `investment_transactions` ADD `cancel_transaction_id` text;--> statement-breakpoint
ALTER TABLE `investment_transactions` ADD `raw_json` text;--> statement-breakpoint
ALTER TABLE `securities` ADD `isin` text;--> statement-breakpoint
ALTER TABLE `securities` ADD `cusip` text;--> statement-breakpoint
ALTER TABLE `securities` ADD `sedol` text;--> statement-breakpoint
ALTER TABLE `securities` ADD `figi` text;--> statement-breakpoint
ALTER TABLE `securities` ADD `cfi_code` text;--> statement-breakpoint
ALTER TABLE `securities` ADD `institution_security_id` text;--> statement-breakpoint
ALTER TABLE `securities` ADD `proxy_security_id` text;--> statement-breakpoint
ALTER TABLE `securities` ADD `market_identifier_code` text;--> statement-breakpoint
ALTER TABLE `securities` ADD `is_cash_equivalent` integer;--> statement-breakpoint
ALTER TABLE `securities` ADD `subtype` text;--> statement-breakpoint
ALTER TABLE `securities` ADD `close_price` real;--> statement-breakpoint
ALTER TABLE `securities` ADD `close_price_as_of` text;--> statement-breakpoint
ALTER TABLE `securities` ADD `sector` text;--> statement-breakpoint
ALTER TABLE `securities` ADD `industry` text;--> statement-breakpoint
ALTER TABLE `securities` ADD `option_contract_type` text;--> statement-breakpoint
ALTER TABLE `securities` ADD `option_expiration` text;--> statement-breakpoint
ALTER TABLE `securities` ADD `option_strike` real;--> statement-breakpoint
ALTER TABLE `securities` ADD `option_underlying` text;--> statement-breakpoint
ALTER TABLE `securities` ADD `fixed_yield_rate` real;--> statement-breakpoint
ALTER TABLE `securities` ADD `fixed_yield_type` text;--> statement-breakpoint
ALTER TABLE `securities` ADD `fixed_maturity_date` text;--> statement-breakpoint
ALTER TABLE `securities` ADD `fixed_issue_date` text;--> statement-breakpoint
ALTER TABLE `securities` ADD `fixed_face_value` real;--> statement-breakpoint
ALTER TABLE `securities` ADD `provider_updated_at` text;--> statement-breakpoint
ALTER TABLE `securities` ADD `raw_json` text;--> statement-breakpoint
ALTER TABLE `transactions` ADD `sender` text;--> statement-breakpoint
ALTER TABLE `transactions` ADD `sender_source` text;--> statement-breakpoint
ALTER TABLE `transactions` ADD `source` text DEFAULT 'plaid' NOT NULL;--> statement-breakpoint
ALTER TABLE `transactions` ADD `sender_user` text;
--> statement-breakpoint
-- For money that came IN, the person on the other side is the sender, not a recipient.
UPDATE `transactions` SET `sender` = `recipient`, `sender_source` = `recipient_source`, `recipient` = NULL, `recipient_source` = NULL WHERE `amount_minor` < 0 AND `recipient` IS NOT NULL;
--> statement-breakpoint
UPDATE `transactions` SET `sender_user` = `recipient_user`, `recipient_user` = NULL WHERE `amount_minor` < 0 AND `recipient_user` IS NOT NULL;
