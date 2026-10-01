-- Drop the three duplicate btree indexes flagged by PlanetScale Insights
-- (each is a left-prefix of a unique index that already serves its lookups)
-- and the food_avoidances table, which has no write path in the application
-- (re-add it if the Food Profile avoidances feature is built).

DROP INDEX "userIdx";
--> statement-breakpoint
DROP INDEX "householdDateIdx";
--> statement-breakpoint
DROP INDEX "productMatchHouseholdIdx";
--> statement-breakpoint
DROP TABLE "food_avoidances";
