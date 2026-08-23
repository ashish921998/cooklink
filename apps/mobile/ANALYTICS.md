# Cooklink product analytics

Cooklink uses PostHog for explicit, pre-launch product events. Analytics is disabled when
`EXPO_PUBLIC_POSTHOG_API_KEY` is absent, when `EXPO_PUBLIC_POSTHOG_DISABLED=true`, and in the
local design-preview fixture.

## PostHog project

- Organization: `Vinesight`
- Project: `Cooklink` (`572931`, US Cloud)
- Launch dashboard: <https://us.posthog.com/project/572931/dashboard/2024182>
- Setup verification and development-build events carry `is_test_event=true`; every product
  insight excludes them.

## Privacy contract

- No touch autocapture or session replay.
- GeoIP enrichment is disabled.
- The distinct ID is Cooklink's opaque authentication ID—not a phone number, name, or email.
- Events never include household names, meal names, chat content, addresses, or provider tokens.

## Events

| Event | Trigger | Properties |
| --- | --- | --- |
| `week_day_selected` | A member changes the inline day on Today | `day_offset`, `relative_day`, `household_role`, `source` |
| `meal_plan_opened` | A member opens Meal Plan | `household_role`, `source` |
| `recipe_opened` | A planned meal is opened | `has_recipe`, `household_role`, `meal_type`, `source` |
| `cart_review_opened` | A provider cart is successfully built for review | `cart_mode`, `has_unavailable_items`, `item_count`, `provider` |
| `checkout_started` | A member requests the final checkout confirmation | `has_unavailable_items`, `item_count`, `provider` |

## First dashboards

1. **Week engagement:** unique users with `week_day_selected`, broken down by `day_offset`.
2. **Plan depth:** `week_day_selected` → `meal_plan_opened` → `recipe_opened` within one session.
3. **Grocery conversion:** `cart_review_opened` → `checkout_started`, broken down by
   `has_unavailable_items` and `cart_mode`.

Use a separate PostHog project if ongoing development traffic grows beyond the one-time excluded
setup events.
