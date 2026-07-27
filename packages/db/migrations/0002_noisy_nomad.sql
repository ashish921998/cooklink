CREATE TABLE `product_matches` (
	`id` char(36) NOT NULL,
	`household_id` char(36) NOT NULL,
	`cart_item_id` varchar(128) NOT NULL,
	`product_id` varchar(128) NOT NULL,
	`address_id` varchar(128) NOT NULL,
	`quantity` int NOT NULL DEFAULT 1,
	`product` json NOT NULL,
	`selected_by_id` char(36) NOT NULL,
	`created_at` datetime(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP(3)),
	CONSTRAINT `product_matches_id` PRIMARY KEY(`id`),
	CONSTRAINT `householdCartIdx` UNIQUE(`household_id`,`cart_item_id`)
);
--> statement-breakpoint
CREATE INDEX `productMatchHouseholdIdx` ON `product_matches` (`household_id`);