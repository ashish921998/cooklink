# Cooklink V1: Find the smallest implementation-ready product

Label: `wayfinder:map`

## Destination

Produce an implementation-ready V1 specification for an Expo iOS and Android app that lets Bengaluru Household Members and their Cooks coordinate weekly meals, recipes, groceries, and chat, with eligible Instamart orders completed through Swiggy MCP.

## Notes

- Planning only: this map resolves product and technical decisions; implementation starts after the specification is handed off.
- Consult `wayfinder`, `grilling`, and `domain-modeling` while resolving decisions. Use `prototype` for interaction tickets and `research` for external facts.
- Preserve the canonical language in [`CONTEXT.md`](../../CONTEXT.md).
- V1 must feel immediately useful and familiar: automatic plans for Members; a WhatsApp-like household list and chat-first experience for Cooks.
- Minimize setup and routine data entry. Prefer implicit learning and estimates that clearly admit uncertainty.
- Both Household Members and Cooks use the Expo mobile app. English and Hindi are supported; Instamart is the only commerce provider.

## Decisions so far

<!-- Closed decision tickets are indexed here; their answers live in the ticket files. -->

- [Verify the Instamart MCP contract for Cooklink](issues/01-verify-instamart-mcp-contract.md) — The intended journey is supported, with delegated per-member OAuth, exact cart review, fresh confirmation, conservative ₹1,000 fallback, and non-idempotent/partial checkout safeguards.
- [Verify the minimal Expo platform foundation](issues/02-verify-expo-platform-feasibility.md) — One Expo app is feasible when household authorization, private chat/media, Swiggy access, and ElevenLabs generation are enforced behind an authenticated server boundary.
- [Prototype the Member and Cook navigation model](issues/03-prototype-member-and-cook-navigation.md) — Variant A is selected: Members open Today with Today, Meal Plan, and Groceries as persistent destinations; Cooks open the Household list, then each Household chat-first with Chat, Meal Plan, and Groceries.
- [Define automatic meal planning and effortless correction](issues/04-define-automatic-meal-planning.md) — A seven-day breakfast/lunch/dinner Weekly Meal Plan becomes active immediately from lightweight household signals, stays editable by Members and Cooks, and learns from corrections without approval or onboarding friction.
- [Define Estimated Pantry and three-day grocery suggestions](issues/05-define-estimated-pantry-and-cart.md) — Cooklink keeps an Estimated Pantry, never an exact inventory, by adding completed Instamart orders, subtracting planned recipe consumption, and folding in approved Cook Grocery Requests; it produces an editable, Member-reviewed Suggested Grocery Cart for today and the next two days.
- [Define household communication and notification rules](issues/06-define-household-communication-rules.md) — Household Chat is a bilingual action surface over structured records, with explicit confirmations, role-aware grocery actions, shared two-Cook history, durable system events, and user-controlled All/Important/Muted notifications.
- [Choose the minimal secure technical architecture](issues/07-choose-minimal-technical-architecture.md) — One Expo app over a stitched backend: PlanetScale MySQL in Mumbai, Clerk phone-OTP auth, a single TypeScript/Hono server enforcing household authorization, Cloudflare R2 media, push-plus-polling delivery with realtime deferred, server-side Swiggy MCP, AI intent, and ElevenLabs, no provider secret in the bundle, and ordering gated behind Swiggy production access.
- [Validate the complete Cooklink V1 specification](issues/08-validate-the-v1-specification.md) — The end-to-end journey and live review closed first-use, recipe, pantry, checkout, accessibility, and dual-role gaps; the resulting specification is ready for implementation.

## Not yet specified

- None. The implementation route is recorded in [Cooklink V1 specification](spec.md).

## Out of scope

- Exact pantry counts or routine inventory entry.
- Calories, macros, medical diets, and nutrition analytics.
- Grocery purchasing without explicit Household Member confirmation.
- Cook scheduling, attendance, routes, salaries, or payments.
- Direct messages, multiple chat groups, calls, video, reactions, and read receipts.
- Swiggy Food, Dineout, or commerce providers other than Instamart.
- Languages beyond English and Hindi.
- Web dashboards, admin portals, and Raycast or desktop surfaces.
- Assigning meals between a Household's Cooks.
