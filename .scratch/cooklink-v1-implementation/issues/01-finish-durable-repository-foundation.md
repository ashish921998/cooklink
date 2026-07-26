# 01 — Finish the durable repository foundation

**What to build:** Complete the infrastructure prefactor that makes every later
vertical slice durable and independently verifiable: a production-shaped
repository adapter, initial schema and development data, and a green workspace
build/test baseline. This ticket preserves the already-tested domain behaviour
while replacing in-memory-only persistence at the application boundary.

**Blocked by:** None — can start immediately.

**Status:** ready-for-agent

- [ ] Every domain repository capability required by V1 has a durable adapter
      or an explicit deferred marker with no silent in-memory fallback.
- [ ] Initial migrations create the Household-scoped identity, meal, recipe,
      chat, grocery, notification, media-metadata, token, and checkout-audit
      records needed by the specification.
- [ ] Development seed data creates at least two isolated Households, Member
      and Cook roles, planned meals, recipes, Chat activity, and grocery state.
- [ ] Integration tests prove that durable reads and writes cannot cross
      Household boundaries.
- [ ] Atomic operations such as request-plus-event and checkout audit updates
      are transactionally consistent.
- [ ] The workspace typecheck, build, formatting check, and existing domain
      tests pass from the repository root.

