# Cooklink V1 specification

Status: implementation-ready

## Product

Cooklink is one Expo iOS/Android app for Bengaluru Households and their hired
Cooks. It coordinates automatic weekly meal planning, Recipe Guides, Household
Chat, Grocery Requests, estimated grocery needs, and explicitly confirmed
Swiggy Instamart orders.

V1 has no web, desktop, Raycast, or admin product surface.

## Principles

1. Show value before asking for work: the first active plan appears before
   invitations or detailed personalization.
2. Familiar before powerful: the Cook experience resembles a simple WhatsApp
   household list and chat, not a dashboard.
3. Estimate honestly: Estimated Pantry never claims exact stock or requires
   routine entry.
4. AI proposes; people control: plans are automatic and editable, while every
   checkout requires fresh Household Member confirmation.
5. Everything is Household-scoped and authorized on the server.
6. Use plain English or Hindi and icon-plus-text controls.

## Accounts and Household roles

- Sign-in is passwordless phone OTP.
- A person has one account and exactly one role inside a given Household:
  Household Owner, Household Member, or Cook.
- The same account may use **My home** as a Member and **Work households** as a
  Cook elsewhere. The app remembers the last area.
- The Owner creates the Household, manages membership, and sends invites.
- Members manage preferences and plans, approve Grocery Requests, and order.
- Cooks read and directly edit plans, use Recipe Guides, chat, and create
  Grocery Requests; they cannot approve requests, manage carts, or order.
- A Household has at most two active Cooks.
- A Cook has at most 30 active Households.
- V1 does not assign individual meals between Cooks.

## First use and invitations

1. The first verified person becomes Household Owner.
2. They provide Household name/photo, usual Serving Count, North or South
   Indian Meal Style, and Vegetarian/Eggetarian/Non-vegetarian preference.
3. Food avoidances, health-emphasis chips, and Special Meal preference are
   optional and skippable.
4. Generation feedback appears immediately.
5. A usable active seven-day plan appears within 15 seconds on a normal
   network. If personalization misses the target, activate a safe starter plan
   and refine it in the background.
6. Offer invitations after the plan appears.

A Household Invite is role-specific, phone-bound, single-use, revocable, and
expires after seven days. Acceptance requires matching phone OTP. An existing
Cook who accepts another invite sees the Household in Work households.

## Navigation

### Household Member

- Launch into the active Household's **Today** destination.
- Persistent destinations: **Today**, **Meal Plan**, and **Groceries**.
- Household Chat is a header action from every destination.
- Back from Chat returns to the invoking destination.

### Cook

- Launch into a WhatsApp-like **Households** list, even with one Household.
- Rows prioritize Household name, photo, recent activity, and unread state.
- Selecting a Household opens **Chat**.
- Persistent Household destinations: **Chat**, **Meal Plan**, and
  **Groceries**.
- A pinned **Today's cooking** card opens the Daily Cook View.
- Back returns to the Household list.
- Switching Households must never retain another Household's content, drafts,
  media, unread state, or permissions.

See [Prototype the Member and Cook navigation model](issues/03-prototype-member-and-cook-navigation.md).

## Weekly Meal Plan

- One active plan covers seven days starting today.
- Every day has breakfast, lunch, and dinner.
- Generated plans become active immediately; there is no approval state.
- Members and Cooks may edit meals directly.
- Changes are attributed in Household Chat and produce role-aware
  notifications.

Generation considers Food Profiles, diet style, Meal Style, Serving Count,
history, optional higher-protein/more-vegetables/lighter-meals emphasis, and an
optional richer Special Meal approximately once per week.

Plans default to familiar, balanced Indian home cooking. V1 does not expose
calories, macros, medical diets, or nutrition scores.

Users can swap meals, regenerate a meal/day/future range, search or type a
replacement, accept a Cook edit, and optionally give thumbs feedback. Repeated
explicit choices are strong Household-scoped learning signals. Nothing in meal
planning authorizes a grocery purchase.

See [Define automatic meal planning and effortless correction](issues/04-define-automatic-meal-planning.md).

## Recipe Guides

- Start with a focused, human-reviewed library of familiar North and South
  Indian home recipes.
- AI may adapt verified recipes to language, Serving Count, and simple
  preferences.
- Unsupported dishes may receive a clearly labelled, editable AI-generated
  draft; they are not presented as verified.
- Guides contain concise steps and on-demand ElevenLabs audio in English or
  Hindi.
- Dependable ingredient quantities scale deterministically from the base
  Serving Count.
- Salt, oil, spices, water, and judgement-based ingredients use ranges or
  “adjust to taste.”
- Only dependable quantities affect Estimated Pantry.
- Audio is generated and cached server-side; no ElevenLabs key is in the app.

## Household Chat

One shared Chat belongs to each Household and supports:

- text;
- one photo with optional caption;
- recorded voice notes;
- correctable transcripts when transcription succeeds;
- attributed system events for meal, grocery, membership, and delivery changes.

There are no direct messages, extra groups, calls, video, reactions, or read
receipts.

Text or voice may create a private structured-action suggestion. The author
must confirm it before the server rechecks membership and current state. Chat
can edit a meal or create a Grocery Request but cannot place an order.

Notification defaults are **All activity** for Members and **Important only**
for Cooks, with per-Household All/Important/Muted overrides. Bursts collapse by
Household. Payment amounts and order totals never appear in Chat or push
previews. Opening a notification re-authorizes access.

See [Define household communication and notification rules](issues/06-define-household-communication-rules.md).

## Grocery Requests

- A Cook describes a missing ingredient naturally by text or speech.
- Quantity is optional; the Cook does not choose urgency or a product SKU.
- Members are notified into a shared pending queue.
- Any Member may approve, reject, order now, or leave it for the next cart.
- Similar concurrent requests are shown for deliberate update/merge and never
  combined silently.

## Estimated Pantry

Estimated Pantry is non-authoritative:

- completed/delivered Instamart orders add dependable normalized quantities;
- planned recipe consumption subtracts expected quantities at meal time;
- plan edits recalculate future consumption;
- approved Grocery Requests override optimistic availability assumptions;
- perishables degrade through deterministic freshness windows;
- unnormalizable or stale information becomes uncertain, never invented.

User-facing states are only **likely available**, **may be low**, and
**unknown**. There are no exact balances and no pantry screen.

When an uncertain ingredient is required, the Suggested Grocery Cart includes
it with **Check at home** and the affected meal. A Member keeps or removes it
during review.

## Suggested Grocery Cart

- Covers today and the next two calendar days.
- Combines recipe needs, Estimated Pantry, and approved Grocery Requests.
- Explains why and when each item is needed.
- Is editable and never becomes an order automatically.
- Optional removal reasons may improve estimates but pantry entry is never
  required.

See [Define Estimated Pantry and three-day grocery suggestions](issues/05-define-estimated-pantry-and-cart.md).

## Instamart ordering

Only Members connect their individual Swiggy account. Cooks never see checkout.

Cart review shows exact brand, variant, pack size, quantity, price, bill
breakdown, address, store count, and only payment methods returned by
Instamart. Cooklink never silently maps a vague ingredient to a final SKU.

If a product becomes unavailable, block that line and offer up to three exact
available alternatives. A Member deliberately replaces or removes it; there
are no silent substitutions.

When one payment method is returned it may be preselected; several require a
Member choice; none triggers Instamart fallback. Cooklink never collects or
stores payment credentials.

Immediately before checkout, show the canonical cart, address, payment method,
store count, and total, then request fresh confirmation. Plan generation,
request approval, and cart edits never count as consent.

- Eligible carts below ₹1,000 may complete through Swiggy MCP.
- Carts at or above ₹1,000 continue in Instamart with the synchronized cart.
- Cooklink does not promise a direct cart deep link.
- Checkout is non-idempotent. After uncertainty, query order history before
  considering a retry.
- Multi-store partial results are represented per resulting order.
- Real ordering stays feature-gated until Swiggy grants production access.

See [Verify the Instamart MCP contract for Cooklink](issues/01-verify-instamart-mcp-contract.md).

## Language and accessibility

- Cook setup offers English or Hindi, defaults to English if skipped, and can
  be changed later.
- System events and Recipe Guides follow the viewer's language.
- Human messages are not translated automatically.
- Navigation is plain-language, consistently placed, and icon-plus-text.

V1 uses native iOS/Android conventions with WCAG 2.2 AA as a supporting
baseline:

- manually test critical journeys with VoiceOver and TalkBack;
- 4.5:1 normal-text contrast and 3:1 for large text and meaningful controls;
- 44-by-44-point iOS and 48-by-48-dp Android minimum targets;
- largest supported system text reflows or scrolls without hiding actions;
- status never relies on colour alone;
- dynamic changes, errors, confirmations, and checkout results receive
  announcements and focus recovery;
- reduced motion is respected;
- Recipe Guide text is the equivalent of audio;
- uncertain voice transcripts are labelled and correctable.

## Technical architecture

- **Mobile:** one Expo iOS/Android development-build app.
- **Authentication:** Clerk phone OTP; server verifies session JWTs.
- **Authorization:** `(person, Household, Household Role)` enforced server-side.
- **Database:** PlanetScale MySQL, Mumbai, unsharded.
- **Server:** one TypeScript/Hono/Drizzle service in Mumbai.
- **Media:** private Cloudflare R2 objects behind authorized signed URLs.
- **Delivery:** Expo push plus cursor polling; websockets deferred.
- **AI:** server-side intent and plan generation selected through a
  Hindi/Hinglish evaluation set.
- **Speech:** server-side ElevenLabs generation with content-keyed caching.
- **Commerce:** server-side Swiggy MCP with encrypted per-Member OAuth tokens.
- **Observability:** structured logs, Sentry-compatible error capture,
  authorization-denial logs, and append-only checkout audit records.

No provider secret, service credential, or database key may appear in the
mobile bundle or an `EXPO_PUBLIC_*` variable.

See [Choose the minimal secure technical architecture](issues/07-choose-minimal-technical-architecture.md).

## Acceptance criteria

1. The first verified user becomes Owner and receives an active plan before
   invitations.
2. A usable plan appears within 15 seconds or a safe starter activates.
3. Members launch into Today; Cooks launch into the Household list.
4. Every Cook Household opens Chat and exposes only Chat, Meal Plan, and
   Groceries as persistent destinations.
5. Switching Households never leaks data, state, or permissions.
6. Members and Cooks can edit meals; attributed changes appear in Chat.
7. Recipe Guides show verified or clearly labelled draft provenance and scale
   dependable quantities correctly.
8. Recipe text and on-demand audio work in English and Hindi.
9. Chat supports text, photo, voice note, and safe structured events.
10. A Cook can create but cannot approve or purchase a Grocery Request.
11. Estimated Pantry never displays exact balances or requires routine entry.
12. The three-day cart marks uncertain items as Check at home.
13. Exact Instamart products and returned payment methods appear before fresh
    confirmation.
14. No unavailable product is silently substituted.
15. Checkout uncertainty cannot create a blind duplicate order.
16. ₹1,000-or-more and unsupported-payment cases use Instamart fallback.
17. Server tests prove Household authorization for every scoped object/action.
18. Critical journeys pass VoiceOver, TalkBack, text-scale, contrast,
    touch-target, focus, and reduced-motion checks.
19. One account can use My home and Work households while retaining one role
    per Household.
20. Real ordering is visibly unavailable until Swiggy production approval.

## External release gates

These are not unresolved product decisions:

- Swiggy platform-operator onboarding and production approval.
- Approved mobile OAuth callback design.
- Staging verification of payment methods, synchronized-cart fallback, partial
  checkout, and order-history recovery.
- Hindi/Hinglish AI evaluation.
- Human review of the initial recipe library.
- Hindi ElevenLabs pronunciation review.
- iOS/Android notification credentials and device testing.
- Privacy copy covering identity, tokens, media, transcripts, and R2 storage.

## Out of scope

- Exact inventory or routine pantry entry.
- Calories, macros, medical diets, and nutrition analytics.
- Automatic grocery purchasing.
- Cook scheduling, attendance, routes, salaries, or payments.
- Direct messages, multiple groups, calls, video, reactions, or read receipts.
- Swiggy Food, Dineout, or non-Instamart providers.
- Languages beyond English and Hindi.
- Web dashboards, admin portals, Raycast, or desktop surfaces.
- Meal assignment between Cooks.
- Realtime websockets unless observed usage demonstrates a need.

## Decision sources

- [Cooklink domain language](../../CONTEXT.md)
- [Wayfinder map](map.md)
- [Instamart MCP research](research/instamart-mcp-contract.md)
- [Expo platform research](research/expo-platform-foundation.md)
- [Navigation prototype](../../prototype/member-cook-navigation/README.md)
- [End-to-end validation prototype](../../prototype/v1-journey/README.md)
