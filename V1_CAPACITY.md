# Cooklink V1 capacity target

## Target envelope

V1 targets 1,000–10,000 registered people on a single Railway application
replica in the Mumbai/Singapore vicinity, backed by pooled PostgreSQL. The
launch assumption is at most 1,000 daily active people, 100 concurrently active
people, and 50 sustained API requests per second. This is a capacity target,
not evidence that every external dependency has approved production use.

## Automated gates

- `pnpm typecheck`, `pnpm lint`, `pnpm test`, and `pnpm format:check` pass.
- `pnpm load:smoke <url> 1000 25` returns 100% successful responses.
- A database-backed staging run sustains 50 requests/second for 10 minutes with
  p95 below 1.5 seconds and fewer than 1% 5xx responses on the most common
  authenticated flows: session bootstrap, Household list, Meal Plan, Chat
  timeline, and Suggested Grocery Cart.
- Railway health checks use `/ready`, which verifies PostgreSQL connectivity
  and the latest launch-critical migration.
- Database migrations run as a Railway pre-deploy command and block promotion
  on failure.
- Error capture and alerting are configured and a synthetic exception reaches
  the production project.

## Single-replica constraints

Do not enable a second application replica until all process-local state has
been removed or coordinated. Current blockers are:

- Chat photo and voice storage uses `InMemoryMediaStore`; objects disappear on
  restart and are unavailable to another replica.
- Scheduled jobs run inside every application process and do not yet use a
  distributed lease for the sweeps. The order-tracking poll claims its work
  through the database (`FOR UPDATE SKIP LOCKED` plus a per-order `tracked_at`
  lease). A transaction-scoped member advisory lock prevents overlapping
  provider requests even after a claim expires, and its
  locked monotonic status transitions keep event emission exactly-once across
  instances; the other sweeps merely duplicate work.
- Waitlist throttling is per process. Add an edge or shared-store limit before
  horizontal scaling or a large public campaign.

Resolved (2026-09-09): pending Swiggy OAuth handshakes, browser-callback
routing, the recent-product cache, and checkout confirmation tokens are all
durable in PostgreSQL (`swiggy_oauth_pending`, `swiggy_oauth_callbacks`,
`swiggy_recent_products`, `checkout_confirmations`; migration
`0002_durable_flow_state_order_tracking`), consumed atomically, swept by the
`flow_state_cleanup` job, and covered by the Postgres-backed
`flow-state.durable.test.ts` cross-instance suite.

## Public-launch blockers

- Configure Clerk production keys and disable development authentication.
- Configure the EAS production API URL and Clerk publishable key.
- Replace in-memory Chat media with durable private object storage.
- Configure Sentry/GlitchTip and verify alert delivery.
- Publish a privacy policy and implement account/data deletion.
- Complete physical-device authentication, media, VoiceOver, TalkBack, and
  largest-text testing.
- Keep real ordering disabled until Swiggy staging, OAuth, payment, and
  synchronized-cart behavior are approved and validated.

The repository is ready for a controlled beta only after every applicable
blocker above has named evidence and an owner. Public V1 is not approved by a
green unit-test run alone.
