CREATE TYPE "public"."cart_member_state" AS ENUM('pending', 'kept', 'removed');--> statement-breakpoint
CREATE TYPE "public"."chat_kind" AS ENUM('text', 'photo', 'voice');--> statement-breakpoint
CREATE TYPE "public"."confidence" AS ENUM('likely_available', 'may_be_low', 'unknown');--> statement-breakpoint
CREATE TYPE "public"."device_platform" AS ENUM('ios', 'android');--> statement-breakpoint
CREATE TYPE "public"."diet_style" AS ENUM('vegetarian', 'eggetarian', 'nonvegetarian');--> statement-breakpoint
CREATE TYPE "public"."grocery_order_status" AS ENUM('pending', 'placed', 'failed', 'delivered');--> statement-breakpoint
CREATE TYPE "public"."grocery_request_status" AS ENUM('pending', 'approved', 'rejected', 'cancelled', 'in_order', 'fulfilled');--> statement-breakpoint
CREATE TYPE "public"."idempotency_status" AS ENUM('in_flight', 'succeeded', 'failed');--> statement-breakpoint
CREATE TYPE "public"."invite_role" AS ENUM('member', 'cook');--> statement-breakpoint
CREATE TYPE "public"."invite_status" AS ENUM('pending', 'accepted', 'revoked', 'expired');--> statement-breakpoint
CREATE TYPE "public"."language" AS ENUM('en', 'hi');--> statement-breakpoint
CREATE TYPE "public"."meal_style" AS ENUM('north', 'south');--> statement-breakpoint
CREATE TYPE "public"."meal_type" AS ENUM('breakfast', 'lunch', 'dinner');--> statement-breakpoint
CREATE TYPE "public"."membership_role" AS ENUM('owner', 'member', 'cook');--> statement-breakpoint
CREATE TYPE "public"."membership_status" AS ENUM('active', 'removed');--> statement-breakpoint
CREATE TYPE "public"."need_day" AS ENUM('today', 'tomorrow', 'day_after');--> statement-breakpoint
CREATE TYPE "public"."notification_level" AS ENUM('all', 'important', 'muted');--> statement-breakpoint
CREATE TYPE "public"."pantry_source" AS ENUM('order_delivered', 'consumption', 'request_override', 'member_edit');--> statement-breakpoint
CREATE TYPE "public"."provenance" AS ENUM('verified', 'ai_draft');--> statement-breakpoint
CREATE TYPE "public"."removal_reason" AS ENUM('already_have', 'not_needed', 'buy_later');--> statement-breakpoint
CREATE TYPE "public"."suggestion_status" AS ENUM('pending', 'confirmed', 'dismissed', 'expired', 'failed');--> statement-breakpoint
CREATE TYPE "public"."transcript_status" AS ENUM('pending', 'ready', 'failed');--> statement-breakpoint
CREATE TABLE "action_suggestions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"household_id" uuid NOT NULL,
	"author_id" uuid NOT NULL,
	"source_message_id" uuid,
	"intent" jsonb NOT NULL,
	"status" "suggestion_status" DEFAULT 'pending' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "chat_messages" (
	"id" uuid PRIMARY KEY NOT NULL,
	"household_id" uuid NOT NULL,
	"sender_id" uuid NOT NULL,
	"kind" "chat_kind" NOT NULL,
	"body" text,
	"caption" varchar(512),
	"media_ref" varchar(512),
	"client_created_at" timestamp with time zone NOT NULL,
	"server_created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"edited_at" timestamp with time zone,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "checkout_audit" (
	"id" uuid PRIMARY KEY NOT NULL,
	"idempotency_key" varchar(128) NOT NULL,
	"membership_id" uuid NOT NULL,
	"household_id" uuid NOT NULL,
	"cart_total_cents" bigint,
	"payment_method" varchar(64),
	"result" varchar(64) NOT NULL,
	"verified_via_get_orders" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "checkout_audit_cart_total_cents_nonneg" CHECK ("checkout_audit"."cart_total_cents" >= 0)
);
--> statement-breakpoint
CREATE TABLE "device_registrations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"push_token" varchar(256) NOT NULL,
	"platform" "device_platform" NOT NULL,
	"hide_previews" boolean DEFAULT false NOT NULL,
	"last_success_at" timestamp with time zone,
	"invalidated_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "food_avoidances" (
	"id" uuid PRIMARY KEY NOT NULL,
	"household_id" uuid NOT NULL,
	"user_id" uuid,
	"food" varchar(64) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "grocery_orders" (
	"id" uuid PRIMARY KEY NOT NULL,
	"household_id" uuid NOT NULL,
	"placed_by_id" uuid NOT NULL,
	"provider_order_id" varchar(128),
	"status" "grocery_order_status" DEFAULT 'pending' NOT NULL,
	"total_cents" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "grocery_orders_total_cents_nonneg" CHECK ("grocery_orders"."total_cents" >= 0)
);
--> statement-breakpoint
CREATE TABLE "grocery_requests" (
	"id" uuid PRIMARY KEY NOT NULL,
	"household_id" uuid NOT NULL,
	"item_text" varchar(256) NOT NULL,
	"quantity_text" varchar(64),
	"status" "grocery_request_status" DEFAULT 'pending' NOT NULL,
	"created_by_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_by_id" uuid,
	"resolved_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "household_invites" (
	"id" uuid PRIMARY KEY NOT NULL,
	"household_id" uuid NOT NULL,
	"role" "invite_role" NOT NULL,
	"phone_hash" varchar(128) NOT NULL,
	"token" varchar(64) NOT NULL,
	"status" "invite_status" DEFAULT 'pending' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"accepted_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "household_member_state" (
	"user_id" uuid NOT NULL,
	"household_id" uuid NOT NULL,
	"last_read_message_id" uuid,
	"notification_override" "notification_level"
);
--> statement-breakpoint
CREATE TABLE "households" (
	"id" uuid PRIMARY KEY NOT NULL,
	"name" varchar(128) NOT NULL,
	"photo_url" varchar(512),
	"serving_count" integer DEFAULT 4 NOT NULL,
	"meal_style" "meal_style" DEFAULT 'north' NOT NULL,
	"diet_style" "diet_style" DEFAULT 'vegetarian' NOT NULL,
	"health_emphasis" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"special_meal_enabled" boolean DEFAULT false NOT NULL,
	"default_language" "language" DEFAULT 'en' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"closed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "idempotency_keys" (
	"key" varchar(128) PRIMARY KEY NOT NULL,
	"membership_id" uuid NOT NULL,
	"household_id" uuid NOT NULL,
	"status" "idempotency_status" DEFAULT 'in_flight' NOT NULL,
	"result" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "memberships" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"household_id" uuid NOT NULL,
	"role" "membership_role" NOT NULL,
	"status" "membership_status" DEFAULT 'active' NOT NULL,
	"notification_default" "notification_level" DEFAULT 'all' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"removed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "pantry_ledger" (
	"id" uuid PRIMARY KEY NOT NULL,
	"household_id" uuid NOT NULL,
	"ingredient_key" varchar(64) NOT NULL,
	"delta_g" integer,
	"delta_ml" integer,
	"delta_count" integer,
	"source" "pantry_source" NOT NULL,
	"perishable" boolean DEFAULT false NOT NULL,
	"freshness_days" integer,
	"at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "planned_meals" (
	"id" uuid PRIMARY KEY NOT NULL,
	"household_id" uuid NOT NULL,
	"date" varchar(10) NOT NULL,
	"meal_type" "meal_type" NOT NULL,
	"recipe_id" uuid,
	"name" varchar(128) NOT NULL,
	"servings" integer DEFAULT 4 NOT NULL,
	"servings_overridden" boolean DEFAULT false NOT NULL,
	"is_special" boolean DEFAULT false NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "product_matches" (
	"id" uuid PRIMARY KEY NOT NULL,
	"household_id" uuid NOT NULL,
	"cart_item_id" varchar(128) NOT NULL,
	"product_id" varchar(128) NOT NULL,
	"address_id" varchar(128) NOT NULL,
	"quantity" integer DEFAULT 1 NOT NULL,
	"product" jsonb NOT NULL,
	"selected_by_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "recipes" (
	"id" uuid PRIMARY KEY NOT NULL,
	"name" varchar(128) NOT NULL,
	"name_hi" varchar(128),
	"base_servings" integer DEFAULT 4 NOT NULL,
	"ingredients" jsonb NOT NULL,
	"steps" jsonb NOT NULL,
	"steps_hi" jsonb,
	"provenance" "provenance" DEFAULT 'verified' NOT NULL,
	"diet_style" "diet_style" NOT NULL,
	"meal_style" "meal_style",
	"meal_types" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "suggested_cart_items" (
	"id" varchar(128) PRIMARY KEY NOT NULL,
	"household_id" uuid NOT NULL,
	"ingredient_key" varchar(64),
	"grocery_request_id" uuid,
	"free_text_item" varchar(256),
	"need_day" "need_day" NOT NULL,
	"affected_meals" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"confidence" "confidence" NOT NULL,
	"member_state" "cart_member_state" DEFAULT 'pending' NOT NULL,
	"removal_reason" "removal_reason"
);
--> statement-breakpoint
CREATE TABLE "swiggy_tokens" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"encrypted_access_token" text NOT NULL,
	"encrypted_refresh_token" text,
	"expires_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "system_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"household_id" uuid NOT NULL,
	"type" varchar(48) NOT NULL,
	"actor_id" uuid,
	"entity_type" varchar(48) NOT NULL,
	"entity_id" varchar(64) NOT NULL,
	"payload" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY NOT NULL,
	"clerk_user_id" varchar(128) NOT NULL,
	"phone" varchar(32) NOT NULL,
	"display_name" varchar(128) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "voice_transcripts" (
	"message_id" uuid PRIMARY KEY NOT NULL,
	"language" "language",
	"transcript" text,
	"status" "transcript_status" DEFAULT 'pending' NOT NULL,
	"corrected_transcript" text
);
--> statement-breakpoint
ALTER TABLE "action_suggestions" ADD CONSTRAINT "action_suggestions_household_id_households_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."households"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "action_suggestions" ADD CONSTRAINT "action_suggestions_source_message_id_chat_messages_id_fk" FOREIGN KEY ("source_message_id") REFERENCES "public"."chat_messages"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_messages" ADD CONSTRAINT "chat_messages_household_id_households_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."households"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "checkout_audit" ADD CONSTRAINT "checkout_audit_household_id_households_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."households"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "device_registrations" ADD CONSTRAINT "device_registrations_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "food_avoidances" ADD CONSTRAINT "food_avoidances_household_id_households_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."households"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "food_avoidances" ADD CONSTRAINT "food_avoidances_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grocery_orders" ADD CONSTRAINT "grocery_orders_household_id_households_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."households"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grocery_requests" ADD CONSTRAINT "grocery_requests_household_id_households_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."households"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "household_invites" ADD CONSTRAINT "household_invites_household_id_households_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."households"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "household_invites" ADD CONSTRAINT "household_invites_accepted_by_user_id_users_id_fk" FOREIGN KEY ("accepted_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "household_member_state" ADD CONSTRAINT "household_member_state_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "household_member_state" ADD CONSTRAINT "household_member_state_household_id_households_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."households"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "household_member_state" ADD CONSTRAINT "household_member_state_last_read_message_id_chat_messages_id_fk" FOREIGN KEY ("last_read_message_id") REFERENCES "public"."chat_messages"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "idempotency_keys" ADD CONSTRAINT "idempotency_keys_household_id_households_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."households"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_household_id_households_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."households"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pantry_ledger" ADD CONSTRAINT "pantry_ledger_household_id_households_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."households"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "planned_meals" ADD CONSTRAINT "planned_meals_household_id_households_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."households"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "planned_meals" ADD CONSTRAINT "planned_meals_recipe_id_recipes_id_fk" FOREIGN KEY ("recipe_id") REFERENCES "public"."recipes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_matches" ADD CONSTRAINT "product_matches_household_id_households_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."households"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "suggested_cart_items" ADD CONSTRAINT "suggested_cart_items_household_id_households_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."households"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "suggested_cart_items" ADD CONSTRAINT "suggested_cart_items_grocery_request_id_grocery_requests_id_fk" FOREIGN KEY ("grocery_request_id") REFERENCES "public"."grocery_requests"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "swiggy_tokens" ADD CONSTRAINT "swiggy_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "system_events" ADD CONSTRAINT "system_events_household_id_households_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."households"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "voice_transcripts" ADD CONSTRAINT "voice_transcripts_message_id_chat_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."chat_messages"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "authorIdx" ON "action_suggestions" USING btree ("author_id","status");--> statement-breakpoint
CREATE INDEX "suggestionsHouseholdIdx" ON "action_suggestions" USING btree ("household_id");--> statement-breakpoint
CREATE INDEX "householdServerIdx" ON "chat_messages" USING btree ("household_id","server_created_at");--> statement-breakpoint
CREATE INDEX "checkoutAuditHouseholdIdx" ON "checkout_audit" USING btree ("household_id");--> statement-breakpoint
CREATE UNIQUE INDEX "deviceTokenIdx" ON "device_registrations" USING btree ("push_token");--> statement-breakpoint
CREATE INDEX "foodAvoidancesHouseholdIdx" ON "food_avoidances" USING btree ("household_id");--> statement-breakpoint
CREATE INDEX "groceryOrdersHouseholdIdx" ON "grocery_orders" USING btree ("household_id");--> statement-breakpoint
CREATE INDEX "householdStatusIdx" ON "grocery_requests" USING btree ("household_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "inviteTokenIdx" ON "household_invites" USING btree ("token");--> statement-breakpoint
CREATE INDEX "invitesHouseholdIdx" ON "household_invites" USING btree ("household_id");--> statement-breakpoint
CREATE UNIQUE INDEX "memberStateIdx" ON "household_member_state" USING btree ("user_id","household_id");--> statement-breakpoint
CREATE INDEX "membershipsHouseholdIdx" ON "memberships" USING btree ("household_id");--> statement-breakpoint
CREATE INDEX "userIdx" ON "memberships" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "userHouseholdStatusIdx" ON "memberships" USING btree ("user_id","household_id","status");--> statement-breakpoint
CREATE INDEX "householdKeyIdx" ON "pantry_ledger" USING btree ("household_id","ingredient_key");--> statement-breakpoint
CREATE UNIQUE INDEX "slotIdx" ON "planned_meals" USING btree ("household_id","date","meal_type");--> statement-breakpoint
CREATE INDEX "householdDateIdx" ON "planned_meals" USING btree ("household_id","date");--> statement-breakpoint
CREATE UNIQUE INDEX "householdCartIdx" ON "product_matches" USING btree ("household_id","cart_item_id");--> statement-breakpoint
CREATE INDEX "productMatchHouseholdIdx" ON "product_matches" USING btree ("household_id");--> statement-breakpoint
CREATE INDEX "suggestedCartHouseholdIdx" ON "suggested_cart_items" USING btree ("household_id");--> statement-breakpoint
CREATE INDEX "householdCreatedIdx" ON "system_events" USING btree ("household_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "clerkIdx" ON "users" USING btree ("clerk_user_id");