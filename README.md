# Cooklink

Cooklink coordinates everyday meal planning, cooking, and grocery replenishment
for one household and its hired cook.

This repository contains the V1 implementation: one **Expo** iOS/Android app
and one **TypeScript / Hono / Drizzle** backend over **PlanetScale MySQL**.

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
  db/        Drizzle MySQL schema, migrations, seed
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
pnpm db:migrate         # apply to a local MySQL (DATABASE_URL)
pnpm db:seed            # seed minimal dev data
pnpm dev:server         # http://localhost:3000

# Mobile
pnpm dev:mobile         # Expo dev server
```

See [`apps/server/.env.example`](./apps/server/.env.example) for configuration.
No provider secret is ever placed in the mobile bundle or an `EXPO_PUBLIC_*`
variable; a CI grep test enforces this.

## Status

See [`IMPLEMENTATION.md`](./IMPLEMENTATION.md) for what is implemented, what is
stubbed, and what is feature-gated (notably: real Instamart ordering is
unavailable until Swiggy grants production access).
