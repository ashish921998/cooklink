DROP INDEX `userHouseholdIdx` ON `memberships`;--> statement-breakpoint
ALTER TABLE `memberships` ADD CONSTRAINT `userHouseholdStatusIdx` UNIQUE(`user_id`,`household_id`,`status`);