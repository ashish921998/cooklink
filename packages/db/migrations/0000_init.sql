CREATE TABLE `action_suggestions` (
	`id` char(36) NOT NULL,
	`household_id` char(36) NOT NULL,
	`author_id` char(36) NOT NULL,
	`source_message_id` char(36),
	`intent` json NOT NULL,
	`status` enum('pending','confirmed','dismissed','expired','failed') NOT NULL DEFAULT 'pending',
	`expires_at` datetime(3) NOT NULL,
	`created_at` datetime(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP(3)),
	CONSTRAINT `action_suggestions_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `chat_messages` (
	`id` char(36) NOT NULL,
	`household_id` char(36) NOT NULL,
	`sender_id` char(36) NOT NULL,
	`kind` enum('text','photo','voice') NOT NULL,
	`body` text,
	`caption` varchar(512),
	`media_ref` varchar(512),
	`client_created_at` datetime(3) NOT NULL,
	`server_created_at` datetime(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP(3)),
	`edited_at` datetime(3),
	`deleted_at` datetime(3),
	CONSTRAINT `chat_messages_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `checkout_audit` (
	`id` char(36) NOT NULL,
	`idempotency_key` varchar(128) NOT NULL,
	`membership_id` char(36) NOT NULL,
	`household_id` char(36) NOT NULL,
	`cart_total_cents` bigint unsigned,
	`payment_method` varchar(64),
	`result` varchar(64) NOT NULL,
	`verified_via_get_orders` boolean NOT NULL DEFAULT false,
	`created_at` datetime(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP(3)),
	CONSTRAINT `checkout_audit_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `device_registrations` (
	`id` char(36) NOT NULL,
	`user_id` char(36) NOT NULL,
	`push_token` varchar(256) NOT NULL,
	`platform` enum('ios','android') NOT NULL,
	`hide_previews` boolean NOT NULL DEFAULT false,
	`last_success_at` datetime(3),
	`invalidated_at` datetime(3),
	CONSTRAINT `device_registrations_id` PRIMARY KEY(`id`),
	CONSTRAINT `tokenIdx` UNIQUE(`push_token`)
);
--> statement-breakpoint
CREATE TABLE `food_avoidances` (
	`id` char(36) NOT NULL,
	`household_id` char(36) NOT NULL,
	`user_id` char(36),
	`food` varchar(64) NOT NULL,
	CONSTRAINT `food_avoidances_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `grocery_orders` (
	`id` char(36) NOT NULL,
	`household_id` char(36) NOT NULL,
	`placed_by_id` char(36) NOT NULL,
	`provider_order_id` varchar(128),
	`status` enum('pending','placed','failed','delivered') NOT NULL DEFAULT 'pending',
	`total_cents` bigint unsigned,
	`created_at` datetime(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP(3)),
	CONSTRAINT `grocery_orders_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `grocery_requests` (
	`id` char(36) NOT NULL,
	`household_id` char(36) NOT NULL,
	`item_text` varchar(256) NOT NULL,
	`quantity_text` varchar(64),
	`status` enum('pending','approved','rejected','cancelled','in_order','fulfilled') NOT NULL DEFAULT 'pending',
	`created_by_id` char(36) NOT NULL,
	`created_at` datetime(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP(3)),
	`resolved_by_id` char(36),
	`resolved_at` datetime(3),
	`version` int NOT NULL DEFAULT 1,
	CONSTRAINT `grocery_requests_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `household_invites` (
	`id` char(36) NOT NULL,
	`household_id` char(36) NOT NULL,
	`role` enum('member','cook') NOT NULL,
	`phone_hash` varchar(128) NOT NULL,
	`token` varchar(64) NOT NULL,
	`status` enum('pending','accepted','revoked','expired') NOT NULL DEFAULT 'pending',
	`expires_at` datetime(3) NOT NULL,
	`accepted_by_user_id` char(36),
	`created_at` datetime(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP(3)),
	CONSTRAINT `household_invites_id` PRIMARY KEY(`id`),
	CONSTRAINT `tokenIdx` UNIQUE(`token`)
);
--> statement-breakpoint
CREATE TABLE `household_member_state` (
	`user_id` char(36) NOT NULL,
	`household_id` char(36) NOT NULL,
	`last_read_message_id` char(36),
	`notification_override` enum('all','important','muted'),
	CONSTRAINT `memberStateIdx` UNIQUE(`user_id`,`household_id`)
);
--> statement-breakpoint
CREATE TABLE `households` (
	`id` char(36) NOT NULL,
	`name` varchar(128) NOT NULL,
	`photo_url` varchar(512),
	`serving_count` int NOT NULL DEFAULT 4,
	`meal_style` enum('north','south') NOT NULL DEFAULT 'north',
	`diet_style` enum('vegetarian','eggetarian','nonvegetarian') NOT NULL DEFAULT 'vegetarian',
	`health_emphasis` json NOT NULL DEFAULT ('[]'),
	`special_meal_enabled` boolean NOT NULL DEFAULT false,
	`default_language` enum('en','hi') NOT NULL DEFAULT 'en',
	`created_at` datetime(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP(3)),
	`closed_at` datetime(3),
	CONSTRAINT `households_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `idempotency_keys` (
	`key` varchar(128) NOT NULL,
	`membership_id` char(36) NOT NULL,
	`household_id` char(36) NOT NULL,
	`status` enum('in_flight','succeeded','failed') NOT NULL DEFAULT 'in_flight',
	`result` json,
	`created_at` datetime(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP(3)),
	CONSTRAINT `idempotency_keys_key` PRIMARY KEY(`key`)
);
--> statement-breakpoint
CREATE TABLE `memberships` (
	`id` char(36) NOT NULL,
	`user_id` char(36) NOT NULL,
	`household_id` char(36) NOT NULL,
	`role` enum('owner','member','cook') NOT NULL,
	`status` enum('active','removed') NOT NULL DEFAULT 'active',
	`notification_default` enum('all','important','muted') NOT NULL DEFAULT 'all',
	`created_at` datetime(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP(3)),
	`removed_at` datetime(3),
	CONSTRAINT `memberships_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `pantry_ledger` (
	`id` char(36) NOT NULL,
	`household_id` char(36) NOT NULL,
	`ingredient_key` varchar(64) NOT NULL,
	`delta_g` bigint unsigned,
	`delta_ml` bigint unsigned,
	`delta_count` int,
	`source` enum('order_delivered','consumption','request_override','member_edit') NOT NULL,
	`perishable` boolean NOT NULL DEFAULT false,
	`freshness_days` int,
	`at` datetime(3) NOT NULL,
	CONSTRAINT `pantry_ledger_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `planned_meals` (
	`id` char(36) NOT NULL,
	`household_id` char(36) NOT NULL,
	`date` varchar(10) NOT NULL,
	`meal_type` enum('breakfast','lunch','dinner') NOT NULL,
	`recipe_id` char(36),
	`name` varchar(128) NOT NULL,
	`servings` int NOT NULL DEFAULT 4,
	`servings_overridden` boolean NOT NULL DEFAULT false,
	`is_special` boolean NOT NULL DEFAULT false,
	`version` int NOT NULL DEFAULT 1,
	`updated_by` char(36),
	`updated_at` datetime(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP(3)),
	CONSTRAINT `planned_meals_id` PRIMARY KEY(`id`),
	CONSTRAINT `slotIdx` UNIQUE(`household_id`,`date`,`meal_type`)
);
--> statement-breakpoint
CREATE TABLE `recipes` (
	`id` char(36) NOT NULL,
	`name` varchar(128) NOT NULL,
	`name_hi` varchar(128),
	`base_servings` int NOT NULL DEFAULT 4,
	`ingredients` json NOT NULL,
	`steps` json NOT NULL,
	`steps_hi` json,
	`provenance` enum('verified','ai_draft') NOT NULL DEFAULT 'verified',
	`diet_style` enum('vegetarian','eggetarian','nonvegetarian') NOT NULL,
	`meal_style` enum('north','south'),
	`meal_types` json NOT NULL,
	CONSTRAINT `recipes_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `suggested_cart_items` (
	`id` varchar(128) NOT NULL,
	`household_id` char(36) NOT NULL,
	`ingredient_key` varchar(64),
	`grocery_request_id` char(36),
	`free_text_item` varchar(256),
	`need_day` enum('today','tomorrow','day_after') NOT NULL,
	`affected_meals` json NOT NULL DEFAULT ('[]'),
	`confidence` enum('likely_available','may_be_low','unknown') NOT NULL,
	`member_state` enum('pending','kept','removed') NOT NULL DEFAULT 'pending',
	`removal_reason` enum('already_have','not_needed','buy_later'),
	CONSTRAINT `suggested_cart_items_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `swiggy_tokens` (
	`user_id` char(36) NOT NULL,
	`encrypted_access_token` text NOT NULL,
	`encrypted_refresh_token` text,
	`expires_at` datetime(3) NOT NULL,
	`updated_at` datetime(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP(3)),
	CONSTRAINT `swiggy_tokens_user_id` PRIMARY KEY(`user_id`)
);
--> statement-breakpoint
CREATE TABLE `system_events` (
	`id` char(36) NOT NULL,
	`household_id` char(36) NOT NULL,
	`type` varchar(48) NOT NULL,
	`actor_id` char(36),
	`entity_type` varchar(48) NOT NULL,
	`entity_id` varchar(64) NOT NULL,
	`payload` json NOT NULL,
	`created_at` datetime(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP(3)),
	CONSTRAINT `system_events_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `users` (
	`id` char(36) NOT NULL,
	`clerk_user_id` varchar(128) NOT NULL,
	`phone` varchar(32) NOT NULL,
	`display_name` varchar(128) NOT NULL,
	`created_at` datetime(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP(3)),
	CONSTRAINT `users_id` PRIMARY KEY(`id`),
	CONSTRAINT `clerkIdx` UNIQUE(`clerk_user_id`)
);
--> statement-breakpoint
CREATE TABLE `voice_transcripts` (
	`message_id` char(36) NOT NULL,
	`language` enum('en','hi'),
	`transcript` text,
	`status` enum('pending','ready','failed') NOT NULL DEFAULT 'pending',
	`corrected_transcript` text,
	CONSTRAINT `voice_transcripts_message_id` PRIMARY KEY(`message_id`)
);
--> statement-breakpoint
CREATE INDEX `authorIdx` ON `action_suggestions` (`author_id`,`status`);--> statement-breakpoint
CREATE INDEX `householdIdx` ON `action_suggestions` (`household_id`);--> statement-breakpoint
CREATE INDEX `householdServerIdx` ON `chat_messages` (`household_id`,`server_created_at`);--> statement-breakpoint
CREATE INDEX `householdIdx` ON `checkout_audit` (`household_id`);--> statement-breakpoint
CREATE INDEX `householdIdx` ON `food_avoidances` (`household_id`);--> statement-breakpoint
CREATE INDEX `householdIdx` ON `grocery_orders` (`household_id`);--> statement-breakpoint
CREATE INDEX `householdStatusIdx` ON `grocery_requests` (`household_id`,`status`);--> statement-breakpoint
CREATE INDEX `householdIdx` ON `household_invites` (`household_id`);--> statement-breakpoint
CREATE INDEX `householdIdx` ON `memberships` (`household_id`);--> statement-breakpoint
CREATE INDEX `userIdx` ON `memberships` (`user_id`);--> statement-breakpoint
CREATE INDEX `userHouseholdIdx` ON `memberships` (`user_id`,`household_id`);--> statement-breakpoint
CREATE INDEX `householdKeyIdx` ON `pantry_ledger` (`household_id`,`ingredient_key`);--> statement-breakpoint
CREATE INDEX `householdDateIdx` ON `planned_meals` (`household_id`,`date`);--> statement-breakpoint
CREATE INDEX `householdIdx` ON `suggested_cart_items` (`household_id`);--> statement-breakpoint
CREATE INDEX `householdCreatedIdx` ON `system_events` (`household_id`,`created_at`);