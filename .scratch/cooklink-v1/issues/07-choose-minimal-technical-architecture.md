# Choose the minimal secure technical architecture

Type: grilling
Status: resolved
Blocked by: 01, 02, 03

## Question

Which minimal mobile, backend, data, authentication, authorization, real-time, media, AI, and secret-handling architecture can implement the agreed V1 safely without placing Swiggy MCP, AI, or ElevenLabs credentials in the Expo client or creating infrastructure the product does not yet need?

## Answer

Cooklink V1 is one Expo app over a stitched, minimal backend chosen deliberately for
operational control and BaaS lock-in avoidance over a single bundled platform.
All durable relational state lives in **PlanetScale MySQL** hosted in Mumbai. Identity
is **passwordless phone OTP via Clerk**. A single always-on **TypeScript/Hono server**
in Mumbai owns authorization, the Swiggy MCP client, AI intent detection, ElevenLabs
generation, media signed-URL issuance, and scheduled jobs. Media bytes live in
**Cloudflare R2**. Delivery uses **push notifications plus cursor polling**; live
websocket realtime is deferred until telemetry justifies it.

The defining rule is that **authorization is enforced in the application server**
against the `(user, household, role)` membership tuple, never in the database and never
on the client. PlanetScale provides no row-level security, so there is no DB backstop:
every household-scoped read and write is centralized in shared authorization helpers
and covered by an authorization test suite. Provider secrets (Swiggy, AI, ElevenLabs,
Clerk) never reach the mobile bundle.

Swiggy ordering is a gated capability. It uses delegated per-member OAuth held
server-side, a server-side MCP client over the HTTP transport, fresh Member
confirmation and a server-side role check on every checkout, and an idempotency-key
table to make the non-idempotent checkout duplicate-safe. Real Instamart ordering is
unavailable until Swiggy grants production access; a local MCP stub enables end-to-end
development first.

This architecture operationalizes the product contracts resolved in
[03](03-prototype-member-and-cook-navigation.md),
[04](04-define-automatic-meal-planning.md),
[05](05-define-estimated-pantry-and-cart.md), and
[06](06-define-household-communication-rules.md).

## Architecture at a glance

| Layer | Choice |
| --- | --- |
| Mobile | One Expo app (iOS and Android), role-aware navigation, development builds |
| Authentication | Clerk passwordless phone OTP; server verifies the Clerk session JWT |
| Database | PlanetScale MySQL, Mumbai, unsharded at V1 (full ACID) |
| Authorization | Application server, `(user, household, role)` tuple; no RLS |
| Server | TypeScript + Hono + Drizzle, one always-on instance, Mumbai |
| Delivery | expo-notifications push + cursor polling (websockets deferred) |
| Media | Cloudflare R2 (location hint `apac`), presigned URLs |
| AI intent | Gemini Flash (default), Hindi eval gate, server-side |
| Recipe speech | ElevenLabs, server-generated, on-demand, cached |
| Commerce | Swiggy Instamart MCP, server-side client, per-member OAuth |
| Secrets | Server environment only; never in the bundle |
| Region | India/Asia; R2 media origin in APAC (disclosed) |

## Application boundary and authorization

- One person has one user identity. Roles are household memberships, not a global
  flag. A Cook may belong to up to 30 Households; a Member may belong to more than
  one. Authorization needs the tuple `(user, household, role)` with roles `owner`,
  `member`, and `cook`.
- Authorization is enforced **in the application server on every request**. Client
  role checks are navigation and UX only and are never trusted.
- There is no database row-level security and no DB backstop. All household-scoped
  reads and writes pass through centralized authorization helpers, so a query cannot
  be written that bypasses the membership check.
- Every denied household-scoped access is logged, because an authorization bug must
  surface as a signal rather than silence.
- An automated authorization test suite proves that a membership cannot read, write,
  or subscribe to another Household's data. This mirrors the backend-authorization
  acceptance test in [issue 06](06-define-household-communication-rules.md) but
  enforces it in application logic rather than database policy.

## Authentication

- Sign-in is passwordless **phone OTP** via Clerk. No passwords in V1.
- Clerk owns authentication (who the user is). The application server and PlanetScale
  own authorization (what Household and role the user has).
- The mobile app sends the Clerk session JWT to the server with each request. The
  server verifies it via Clerk's JWKS, maps the Clerk user id to Cooklink memberships,
  and enforces Household scoping. Clerk never needs to know about Households.
- Phone-number personal data flows through Clerk. Use Clerk's data-residency option
  closest to India and disclose this in the privacy copy. OTP delivery is Clerk-owned;
  monitor Indian SMS delivery quality and bring a custom SMS provider (for example
  Twilio) on higher plans if Clerk's default underperforms.
- Swiggy delegated OAuth is a separate, per-member integration authorization and is
  not the Cooklink login.

## Database

- All durable relational state — memberships, Households, Weekly Meal Plan, Grocery
  Requests, Suggested Cart, Estimated Pantry ledger, chat messages and events,
  suggestions, read state, push tokens, encrypted Swiggy tokens, idempotency keys,
  and the checkout audit log — lives in **PlanetScale MySQL**.
- The database is pinned to a Mumbai region for latency and data residency, and runs
  **unsharded at V1**, so ordinary InnoDB ACID transactions apply to multi-row
  mutations such as "create a Grocery Request and append its system event."
- Sharding is not needed at V1 volumes. If sharding is introduced later, Vitess
  cross-shard transaction limits must be designed around; that is explicitly a
  post-V1 concern.
- There is no RLS. Authorization belongs to the application server, not the database.
- MySQL JSON columns hold flexible payloads (meal metadata, intent suggestions,
  notification preferences); relational junction tables hold the membership graph.
- PlanetScale point-in-time recovery supports the 30-day Household-closure recovery
  window resolved in [issue 06](06-define-household-communication-rules.md).

## Application server

- One always-on **TypeScript service using Hono on Node**, with **Drizzle** as the
  MySQL ORM. TypeScript is shared with the Expo app for type alignment.
- It is hosted on a Mumbai-region container host (Fly.io `bom` or Render `ap-south-1`)
  co-located with PlanetScale and the users. It is a long-lived process because it
  runs scheduled jobs, not because it holds websockets.
- It owns, exclusively: Household-scoped authorization; the Swiggy MCP client; AI
  intent detection; ElevenLabs generation; R2 presigned-URL issuance; push
  notification dispatch; and the scheduled-job loop.

## Delivery: push and polling (realtime deferred)

- V1 chat delivery does not use websockets. New messages while the app is
  backgrounded arrive through **push notifications**; an open chat refreshes via
  **cursor-based fetch** (`GET messages?after=<lastId>`) polled at a modest interval
  and on focus or pull-to-refresh.
- Nothing in V1 requires live push. Optimistic concurrency on the server (resolved in
  issues 04 and 06) guarantees correctness for concurrent edits without realtime.
- Live websocket delivery is a **deferred enhancement**. Add it only if telemetry
  shows users waiting in open chats or if concurrent-edit liveness complaints appear;
  at more than one server instance it would require a Redis pub/sub backbone or a
  managed realtime service such as Ably.

## Media and object storage

- PlanetScale stores only media paths and metadata. The bytes — chat photos, voice
  notes, generated recipe audio — live in **Cloudflare R2**, chosen for zero egress.
- R2 is S3-compatible, so the server issues short-lived presigned URLs exactly as for
  S3. Nothing is public; every media fetch is authorized.
- Set the bucket's **location hint to `apac`**. Media origin therefore rests in
  Cloudflare's Asia-Pacific region, not India, though delivery is fast through
  Cloudflare's Mumbai and Bengaluru edge points of presence. This cross-border media
  storage is the single piece of the stack outside India; it is generally permissible
  under India's DPDP and is disclosed in the privacy copy.
- Photos are compressed and voice notes are capped before upload, per
  [issue 06](06-define-household-communication-rules.md). Uploads show independent
  retry state because they can fail separately from message creation.

## Notifications

- `expo-notifications` registers Expo push tokens per user-device; the server sends
  notifications for new messages, meal changes, and Grocery Request transitions per
  the role-aware contract in
  [issue 06](06-define-household-communication-rules.md).
- Push payloads carry a route and opaque identifiers plus the preview content allowed
  by issue 06's disclosure rules; payment and amount content is always redacted.
- Opening a notification re-authorizes the membership and fetches current data. The
  payload never grants access. Stale tokens are pruned.

## Swiggy Instamart boundary

- The mobile client never calls Swiggy. A **server-side MCP client** connects to
  Swiggy's hosted MCP endpoint over the HTTP transport and injects the ordering
  member's OAuth token for each call.
- Each ordering Member connects their own Swiggy account via delegated OAuth; access
  and refresh artifacts are stored **encrypted** in PlanetScale and never sent to the
  client. Cooks do not connect Swiggy and cannot trigger checkout.
- Every checkout requires a **fresh Member confirmation** after exact cart review and
  a **server-side Household-role check**. An automatically generated plan or suggested
  cart never counts as checkout consent (per [issue 01](01-verify-instamart-mcp-contract.md)).
- Checkout is **non-idempotent and duplicate-safe by construction**: a unique
  idempotency-key row in PlanetScale gates every attempt, and after a network error
  or 5xx the server consults `get_orders` before any retry rather than blindly
  re-checking out. Multi-store partial success is handled per returned order.
- Carts at or above ₹1,000, or with no available returned payment method, route to the
  Instamart-app fallback with the synchronized cart; Cooklink does not promise a deep
  link.
- Ordering is **feature-gated**. A local MCP stub enables end-to-end development;
  staging credentials enable review with seeded data; production ordering is labelled
  unavailable until Swiggy grants invite-based access. The Swiggy production checklist
  (confirmation UX, OAuth and error handling, check-before-retry, observability,
  data/consent handling, a support runbook, and gradual rollout) must be satisfied
  before production is enabled.

## AI intent

- Chat intent detection runs **server-side** with the provider key in server
  environment only. The V1 job is detecting meal-plan and Grocery Request intent from
  English, Hindi, and code-mixed (Hinglish) text or voice transcripts; meal-plan
  *generation* remains the separate domain of [issue 04](04-define-automatic-meal-planning.md).
- The default provider is **Gemini Flash** for Hindi quality and low per-call cost.
  `gpt-4o-mini` and Claude Haiku are the fallbacks if structured-output reliability is
  poor.
- The provider is chosen by a **Hindi/Hinglish intent evaluation set**: a few dozen
  real chat lines with expected intents. That eval is the acceptance gate; the brand
  is the default, not the decision.

## ElevenLabs recipe speech

- Recipe audio is generated **server-side** by ElevenLabs, on demand, and never with
  the key in the client (per [issue 02](02-verify-expo-platform-feasibility.md)).
- Output is cached by a content key (recipe version, language, voice, model, settings)
  so repeated plays do not regenerate. The cache lives in R2 with a 90-day TTL and is
  purged or regenerated on demand.
- Before production, validate the chosen voice and model's Hindi pronunciation on
  representative Bengaluru recipes and confirm ElevenLabs plan and data-retention
  terms.

## Scheduled jobs

- The server runs a scheduler for: active-order tracking polling (`track_order` at no
  faster than every ten seconds), expired Swiggy token cleanup, stale push-token
  cleanup, private-suggestion expiry at 24 hours, and the R2 media and TTS TTL sweeps.
- PlanetScale provides no database scheduler, so these live in the server, not the
  database.

## Secret handling

- No Swiggy, AI, ElevenLabs, Clerk secret, or database service key is ever placed in
  the mobile bundle or an `EXPO_PUBLIC_*` variable. All secrets live only in the
  server environment.
- Swiggy per-member OAuth tokens are stored encrypted at rest in PlanetScale.

## Regions and data residency

- Database, application server, and auth run in an India/Asia region (Mumbai where
  the service offers it). The sole cross-border data element is R2 media origin in
  Cloudflare APAC, disclosed in the privacy copy.

## Data retention

- Chat messages and media persist for the life of the Household. Media is purged on
  author delete and purged 30 days after Household closure (per
  [issue 06](06-define-household-communication-rules.md)). There is no proactive
  media age-out at V1 volumes.
- The Estimated Pantry ledger keeps rolling twelve months of line-item detail, then
  drops to aggregates (per [issue 05](05-define-estimated-pantry-and-cart.md)).
- Generated TTS audio is cached for 90 days. Swiggy tokens, push tokens, and private
  suggestions expire per their existing contracts (5-day life, invalidation, 24
  hours).

## Observability

- **Pino structured JSON logs** drain to the host log stream; every request logs
  user, Household, route, latency, and status. No separate log platform at V1.
- **Sentry** (or self-hosted Glitchtip) captures errors and performance.
- A **`checkout_audit` table** in PlanetScale records one append-only row per checkout
  attempt: idempotency key, member, Household, cart total, payment method, result, and
  the `get_orders` verification result. This is mandatory for the ordering path.
- Authorization denials are logged.
- A full metrics platform, dashboards, and distributed tracing are deferred until
  scale demands.

## Offline and outbox

- The Household-scoped client outbox from [issue 06](06-define-household-communication-rules.md)
  shows Sending, Sent, and Failed state and retries on connectivity. The server's
  acceptance time is the source of truth for timeline position; a pending message is
  never visible to others and cannot produce an action until the server accepts it.

## Deferred or out of scope

- Live websocket delivery, presence, typing indicators, reactions, and read receipts
  (until telemetry justifies).
- Database sharding and cross-shard transaction design (V1 is unsharded ACID).
- A separate metrics, tracing, or dashboarding platform.
- Any surface already out of scope in the
  [map](../map.md) (direct messages, video, admin portals, non-Instamart providers).

## Acceptance criteria

1. One Expo app serves both Member and Cook roles through membership records, and
   ships as a development build so OAuth callbacks and remote push work.
2. Authentication is passwordless phone OTP via Clerk; the server verifies a Clerk
   session JWT on every request and never trusts a client-supplied role.
3. Authorization is enforced in the application server against the
   `(user, household, role)` tuple; client role checks are navigation only.
4. All household-scoped reads and writes pass through centralized authorization
   helpers, and an automated suite proves a membership cannot read or mutate another
   Household's data.
5. Every denied household-scoped access is logged.
6. The database is PlanetScale MySQL in Mumbai, unsharded at V1 with full ACID
   transactions, and uses no row-level security.
7. No Swiggy, AI, ElevenLabs, Clerk secret, or service key is present in the mobile
   bundle or any `EXPO_PUBLIC_*` variable, enforced by a CI grep test.
8. Swiggy is invoked only by a server-side MCP client over the HTTP transport using a
   per-member OAuth token stored encrypted in the database; the mobile client never
   calls Swiggy.
9. A unique idempotency-key row gates every checkout attempt, and an uncertain failure
   is resolved via `get_orders` before any retry; partial multi-store results are
   handled per order with no duplicate orders from blind retries.
10. No checkout executes without a fresh Member confirmation and a server-side
    Household-role check; Cooks cannot trigger checkout.
11. Carts at or above ₹1,000, or with no available returned payment method, route to
    the Instamart-app fallback, and the app does not promise a cart deep link.
12. Ordering is feature-gated: a local MCP stub enables development, and real Instamart
    ordering is unavailable until Swiggy grants production access.
13. V1 chat delivery works with push notifications plus cursor-based polling and does
    not require a websocket channel.
14. Media bytes live in Cloudflare R2 with the `apac` location hint and are reachable
    only through short-lived server-issued presigned URLs; no media is public.
15. AI intent detection runs server-side with the provider key in server environment,
    and a Hindi/Hinglish intent evaluation set is the gate for the chosen model
    (default Gemini Flash).
16. ElevenLabs TTS is generated server-side, on demand, cached by content key with a
    90-day TTL, and its key never ships client-side.
17. Scheduled jobs (active-order tracking at no faster than ten seconds, token cleanup,
    suggestion expiry, media and TTS TTL sweeps) run in the server scheduler.
18. Retention holds: Household chat and media persist for the Household's life and are
    purged 30 days after closure; pantry ledger line items roll off at twelve months;
    TTS cache at 90 days.
19. Structured request logs, Sentry error capture, an append-only `checkout_audit`
    table, and authorization-denial logging are present at launch.
20. All compute, database, and auth run in an India/Asia region, and the R2 media
    origin in APAC is the sole cross-border data element, disclosed in the privacy
    copy.
21. Backend tests prove that a message, event, media path, transcript, suggestion,
    order, or notification route cannot cross Household boundaries.
