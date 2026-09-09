# Cooklink

Cooklink coordinates everyday meal planning, cooking, and grocery replenishment
for one household and its hired cook.

This repository contains the V1 implementation: one **Expo** iOS/Android app
and one **TypeScript / Hono / Drizzle** backend over **PlanetScale Postgres**.

> The product and technical decisions live in
> [`CONTEXT.md`](./CONTEXT.md), [`spec.md`](./.scratch/cooklink-v1/spec.md),
> and the resolved [decision tickets](./.scratch/cooklink-v1/issues). The HTML
> files under [`prototype/`](./prototype) are throwaway design evidence.

## Repository layout

```
apps/
  mobile/    Expo Router app (role-aware navigation)
  server/    Hono API + Swiggy MCP/ElevenLabs/AI clients (server-side only)
packages/
  domain/    Pure domain logic, types, authorization (zero infra, fully tested)
  db/        Drizzle PostgreSQL schema, migrations, seed
```

Authorization is enforced **in the application server** against the
`(user, household, role)` tuple. The database has no row-level security; every
household-scoped read and write passes through the centralized authorization
helpers in [`packages/domain`](./packages/domain), which are covered by an
automated isolation test suite.

## Quick start

```sh
pnpm install

# Backend
pnpm db:generate        # generate Drizzle migrations
pnpm db:migrate         # apply to a local PostgreSQL (DATABASE_URL)
pnpm db:seed            # seed minimal dev data
pnpm dev:server         # http://localhost:3000

# Real Instamart MCP (server-side only)
# COOKLINK_SWIGGY_MODE=production
# COOKLINK_PUBLIC_API_URL=https://api.example.com
# SWIGGY_TOKEN_ENCRYPTION_KEY=$(openssl rand -base64 32)
# Keep COOKLINK_ORDERING_ENABLED=false until checkout is approved for the environment.

# Mobile
pnpm dev:mobile         # Expo dev server
```

See [`apps/server/.env.example`](./apps/server/.env.example) for configuration.
The server validates its provider configuration at startup (provider mode —
required explicitly in `NODE_ENV=production` deployments, encryption key for a
real provider, and `COOKLINK_ORDERING_ENABLED=true` with the stub provider is
rejected — a live deployment never silently falls back to stub; misspelled
boolean values like `True` are rejected rather than silently treated as
`false`). The mobile production configuration is validated at **build time**
by the Expo/EAS config entrypoint (`apps/mobile/app.config.ts`): a
`production` EAS build (by `EAS_BUILD_PROFILE` or the bundled
`EXPO_PUBLIC_COOKLINK_PRODUCTION_BUILD` marker) fails the build on a missing
or non-HTTPS/localhost API origin, an origin that embeds credentials, a query,
a fragment, or a path, or a missing Clerk publishable key, while development
and preview builds keep the localhost fallback. No provider secret is ever
placed in the mobile
bundle or an `EXPO_PUBLIC_*`
variable; a CI grep test enforces this.

## Status

The real Instamart MCP adapter, delegated OAuth, encrypted per-member sessions,
address/product/cart synchronization, confirmation, checkout recovery, and
tracking surfaces are implemented. Local development can still select the
deterministic provider stub. Actual order placement remains independently
gated by `COOKLINK_ORDERING_ENABLED` so staging/read-only verification cannot
place an order accidentally.
