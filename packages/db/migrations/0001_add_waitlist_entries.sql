CREATE TABLE "waitlist_entries" (
  "id" uuid PRIMARY KEY NOT NULL,
  "email" varchar(320) NOT NULL,
  "source" varchar(64) DEFAULT 'landing' NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "waitlist_entries_email_idx" ON "waitlist_entries" USING btree ("email");
