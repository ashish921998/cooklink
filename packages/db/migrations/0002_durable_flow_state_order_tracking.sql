-- Durable provider flow state + background order-tracking columns.
-- Replaces the process-local Maps for Swiggy OAuth handshakes, browser
-- callbacks, the recent-product cache, and checkout confirmations, and adds
-- the tracking columns the order-poll job uses to avoid duplicate events.

ALTER TABLE "grocery_orders" ADD COLUMN "provider_status" varchar(32);
--> statement-breakpoint
ALTER TABLE "grocery_orders" ADD COLUMN "tracked_at" timestamp with time zone;
--> statement-breakpoint
CREATE TABLE "swiggy_oauth_pending" (
  "state" varchar(128) PRIMARY KEY NOT NULL,
  "user_id" uuid NOT NULL,
  "redirect_uri" varchar(512) NOT NULL,
  "client_id" varchar(256) NOT NULL,
  "encrypted_client_secret" text,
  "encrypted_code_verifier" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE INDEX "swiggyOAuthPendingExpiresIdx" ON "swiggy_oauth_pending" USING btree ("expires_at");
--> statement-breakpoint
ALTER TABLE "swiggy_oauth_pending" ADD CONSTRAINT "swiggy_oauth_pending_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;
--> statement-breakpoint
CREATE TABLE "swiggy_oauth_callbacks" (
  "state" varchar(128) PRIMARY KEY NOT NULL,
  "user_id" uuid NOT NULL,
  "app_return_uri" varchar(512) NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE INDEX "swiggyOAuthCallbacksExpiresIdx" ON "swiggy_oauth_callbacks" USING btree ("expires_at");
--> statement-breakpoint
ALTER TABLE "swiggy_oauth_callbacks" ADD CONSTRAINT "swiggy_oauth_callbacks_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;
--> statement-breakpoint
CREATE TABLE "checkout_confirmations" (
  "token" varchar(128) PRIMARY KEY NOT NULL,
  "membership_id" uuid NOT NULL,
  "household_id" uuid NOT NULL,
  "snapshot" jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE INDEX "checkoutConfirmationsExpiresIdx" ON "checkout_confirmations" USING btree ("expires_at");
--> statement-breakpoint
ALTER TABLE "checkout_confirmations" ADD CONSTRAINT "checkout_confirmations_household_id_households_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."households"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;
--> statement-breakpoint
CREATE TABLE "swiggy_recent_products" (
  "user_id" uuid NOT NULL,
  "product_id" varchar(128) NOT NULL,
  "product" jsonb NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "swiggy_recent_products" ADD CONSTRAINT "swiggy_recent_products_user_id_user_id_pk" PRIMARY KEY("user_id", "product_id");
--> statement-breakpoint
CREATE INDEX "swiggyRecentProductsUpdatedIdx" ON "swiggy_recent_products" USING btree ("updated_at");
--> statement-breakpoint
ALTER TABLE "swiggy_recent_products" ADD CONSTRAINT "swiggy_recent_products_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;
