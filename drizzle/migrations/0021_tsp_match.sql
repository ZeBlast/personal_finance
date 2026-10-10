ALTER TABLE `tsp_contribution_applications` ADD `employer_minor` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `tsp_contributions` ADD `match_plan` text;--> statement-breakpoint
ALTER TABLE `tsp_contributions` ADD `pay_minor` integer;--> statement-breakpoint
ALTER TABLE `tsp_contributions` ADD `match_percent` real;--> statement-breakpoint
ALTER TABLE `tsp_contributions` ADD `match_up_to_percent` real;--> statement-breakpoint
ALTER TABLE `tsp_contributions` ADD `auto_percent` real;