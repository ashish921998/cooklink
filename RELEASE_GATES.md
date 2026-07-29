# Cooklink V1 Release Gates

This document states exactly what is locally proven, what is feature-gated, and
what still requires account-level production approval before V1 ships. It is
the handoff evidence for issue 13.

## Summary

| Gate | Status | Evidence |
|------|--------|----------|
| End-to-end V1 journey | Locally proven | `v1-journey.test.ts` (2 tests) |
| Accessibility contracts | Locally proven (structural) | `accessibility.test.ts` (27 tests) |
| Localization (EN/HI) | Locally proven | `localization.test.ts` (10 tests) |
| Household isolation | Locally proven | `household-isolation.test.ts` (12 tests); cross-household asserts also in chat-media / authorization suites |
| Secret-free working tree | Locally proven (mobile tree only) | `secrets-grep.ts` + `secrets-grep.test.ts` |
| Secret-free git history | Locally proven | `secrets-history.ts` + `secrets-history.test.ts` (8 tests; reconciled `sk_test_placeholder` fixture) |
| Recovery scenarios | Locally proven | `recovery-scenarios.test.ts` (14 tests) |
| Native Chat media (photo + voice) | Implemented; device validation pending | `apps/mobile/src/lib/media.ts` (expo-image-picker, expo-audio) |
| Swiggy staging | Externally blocked | No production access yet |
| OAuth callback | Externally blocked | Requires Swiggy approval |
| Payment behaviour | Externally blocked | Requires Swiggy staging |
| Synchronized cart fallback | Externally blocked | Requires Swiggy staging |
| Production ordering | Feature-gated | `decideCheckout(..., false)` denies |
| Hindi AI evaluation | Pending | Requires human review |
| Recipe library review | Pending | Requires human review |
| Hindi speech pronunciation | Pending | Requires human review |
| Notification credentials | Pending | iOS/Android push certs needed |
| Privacy copy | Pending | Requires legal review |

---

## 1. End-to-end V1 journey (AC#1)

**Status: Locally proven**

The domain-layer integration test (`packages/domain/src/tests/v1-journey.test.ts`)
drives the complete journey without a database:

1. Owner creates Household
2. Plan generates immediately (21 meals, 7 days x 3)
3. Cook is invited and joins
4. Cook sends a Hindi grocery Chat message
5. Intent becomes a Member-approved Grocery Request
6. Owner approves the request
7. Approved request flows into the Suggested Cart
8. Checkout decisions (eligible / over-limit / disabled)
9. Multi-store partial success classification
10. Cancellation guidance follows the provider contract

A second test proves Cook is denied `review_place_order`, `add_to_cart`, and
`approve_reject_request` capabilities while Owner has them.

The PlanetScale Postgres-backed server tests (in `apps/server/src/tests/`)
prove the same journey through Hono routes with row-level household scoping.
These route-layer tests require a live `DATABASE_URL`; without it they are
skipped, so they are not part of the default local evidence run.

**Not yet proven:** iOS and Android device testing with real Clerk OTP sign-in.
This requires a physical device build and manual verification.

## 2. Accessibility (AC#2)

**Status: Locally proven (structural contracts)**

The accessibility test suite (`apps/mobile/src/tests/accessibility.test.ts`, 27
tests) verifies:

- **Touch targets:** Bottom tabs (minHeight 56), chat header (minHeight 44),
  primary buttons (padding 16 + 17pt text = 49pt), chat back (minHeight 44).
  All meet the 44-pt iOS / 48-dp Android floor.
- **Contrast:** ink on surface (7.07:1), ink on card (7.07:1), inkSoft on
  surface (5.27:1), white on accent (4.60:1), danger on surface (5.93:1),
  brand on surface (7.63:1). All meet WCAG AA 4.5:1.
- **Non-colour state:** BottomTabs uses `accessibilityState={{ selected: isActive }}`
  so the active tab is communicated to VoiceOver/TalkBack without relying on
  colour alone.
- **Accessibility labels:** Every Pressable across all screens has
  `accessibilityRole`. Key surfaces have `accessibilityLabel` (send button,
  record button, photo viewer, meal rows, household list, invite phone input).

**Not yet proven:** Manual VoiceOver and TalkBack testing, largest supported
text, focus recovery, and reduced-motion checks. These require device testing.

## 3. Localization (AC#3)

**Status: Locally proven (domain layer)**

The localization test suite (`packages/domain/src/tests/localization.test.ts`,
10 tests) verifies:

- All 14 system event types render in both English and Hindi
- English and Hindi renders differ for every event type (no fallback leaks)
- Hindi meal type labels are translated (नाश्ता, दोपहर, रात का खाना)
- System event payloads contain no money fields (issue 06, AC#24)
- `groceryFollowUpQuestion` is bilingual
- `conflictActorLabel` is bilingual
- `memberActionLabels` returns complete labels in both languages
- `similarityChoiceLabels` returns complete labels in both languages
- MealPlan screen LABELS cover 25+ keys in both languages

**Not yet proven:** Representative narrow-device layout testing for Hindi text
(which may be wider than English). This requires device testing.

## 4. Household isolation (AC#4)

**Status: Locally proven**

The household isolation suite (`packages/domain/src/tests/household-isolation.test.ts`,
12 tests) proves:

- A member of Household A cannot authorize into Household B
- Chat timelines never cross households
- System events never cross households
- Meal plans are household-scoped
- Grocery requests are household-scoped
- Suggested cart and pantry ledger are household-scoped
- Suggestions are private to their author and household
- Orders are household-scoped
- Media and transcripts do not leak across households
- `isMediaAccessible` denies cross-household mediaRef
- Edit/delete is scoped to sender + household

Cross-household isolation is additionally asserted outside this dedicated
suite: media access in `chat-media.test.ts`, capability denial in
`authorization.test.ts`, and row-level scoping in the Postgres-backed route
tests (the latter run only when `DATABASE_URL` is present). The dedicated
suite count above is the 12 tests in `household-isolation.test.ts`.

## 5. Secret-free repository (AC#5)

**Status: Locally proven**

Two scanners guard the repository:

1. **Working tree scanner** (`apps/server/src/secrets-grep.ts`): Scans all
   files under `apps/mobile/` for provider secret patterns (Stripe keys,
   Google API keys, OpenAI keys, Anthropic keys, database passwords, OAuth
   tokens). Allowlists known-safe files (`.env.example`, documentation).

2. **Git history scanner** (`apps/server/src/secrets-history.ts`): Walks the
   full git commit history via `git log --all -p`, parsing every added line
   from every commit diff. Flags HIGH_ENTROPY literals and ASSIGNMENT patterns.
   The full Cooklink repository history passes clean (verified in test).

Both scanners run as part of the test suite (`secrets-grep.test.ts` with 4
tests and `secrets-history.test.ts` with 8 tests).

**Reconciled fixture:** commit `6133fa8` introduced
`process.env.CLERK_SECRET_KEY = 'sk_test_placeholder'` in `auth.test.ts`. It
is a reviewed all-lowercase dictionary-word placeholder (no digits, never a
real key) but matches the `sk_test_[A-Za-z0-9]{10,}` shape. The history
scanner allowlists this exact value in `KNOWN_PLACEHOLDERS`; the `sk_test_`
prefix is deliberately NOT allowlisted, and a regression test proves a
real-shaped Clerk test key is still flagged.

**Scope and limits:** these are static source/history checks only. They do
not cover secrets injected at runtime via environment variables, the
Postgres database, provider dashboards, or Clerk's backend. The working-tree
scanner covers `apps/mobile/` only; it is not a general whole-repository
secret scanner.

## 6. Recovery scenarios (AC#6)

**Status: Locally proven**

The recovery scenarios suite
(`packages/domain/src/tests/recovery-scenarios.test.ts`, 14 tests) demonstrates:

1. **Checkout failure:** Deterministic failures do not retry blindly
2. **Uncertain result:** Retries only when `get_orders` shows no placed order
3. **Partial success:** Multi-store partial success is classified with counts
4. **Stale confirmation:** Expired checkout confirmation denies checkout
5. **Cancellation:** Guided within the provider window, denied past it
6. **Unavailable product:** Offers up to 3 alternatives, requires deliberate
   replacement (never silently swaps)
7. **Resolved product:** Stays resolved when still available
8. **Unresolved cart item:** Offers candidates without a match
9. **Removed membership:** Denied authorization immediately
10. **Closed household:** All members denied
11. **Expired grocery suggestion:** Cannot be confirmed
12. **Feature-gated checkout:** Disabled state falls back gracefully

**Offline outbox:** The mobile chat client (`apps/mobile/src/lib/chat.ts`)
implements a household-scoped outbox with `sending` / `sent` / `failed` states.
A pending item is local-only until the server accepts it. A removed
membership's queued message fails permanently with "Household access changed".
This is verified through the chat client contract, not a separate test.

**Expired invite:** The invite lifecycle suite
(`apps/server/src/tests/invite-lifecycle.test.ts`) proves an expired invite
cannot be accepted, is not resendable, and is not revocable.

## 7. External provider gates (AC#7)

**Status: Externally blocked**

The following require Swiggy account-level production approval. They are not
assumed and must not be marked as passed without evidence.

| Gate | Status | Notes |
|------|--------|-------|
| Swiggy staging access | Externally blocked | No staging credentials granted yet |
| OAuth callback approval | Externally blocked | Requires Swiggy to approve the redirect URI |
| Payment behaviour | Externally blocked | COD/UPI behaviour must be verified on staging |
| Synchronized cart fallback | Externally blocked | ₹1,000+ cart handoff to Instamart app needs staging |
| Production ordering | Feature-gated | `decideCheckout(totalCents, methods, orderingEnabled=false)` denies all checkout. The flag `orderingEnabled` defaults to false until production access is granted. |

The checkout domain logic is fully tested with `orderingEnabled=true` (eligible
carts, over-limit fallback, no-payment-method fallback, stale confirmation) and
with `orderingEnabled=false` (disabled reason, no fallback). The feature gate
is the single switch that enables real ordering.

## 8. Content and credential gates (AC#8)

**Status: Pending**

| Gate | Status | Notes |
|------|--------|-------|
| Hindi/Hinglish AI evaluation | Pending | Meal plan generation and recipe matching in Hindi/Hinglish needs human evaluation against ground truth |
| Recipe library human review | Pending | The verified recipe library (ingredients, steps, Hindi translations) needs a human cook to validate |
| Hindi speech pronunciation review | Pending | Voice note transcription accuracy for Hindi/Hinglish needs testing with real speakers |
| Notification credentials | Pending | iOS APNs key and Android FCM credentials must be provisioned and tested |
| Privacy copy | Pending | Privacy policy and data-handling copy needs legal review before publication |

## 9. Native Chat media (device validation)

**Status: Implemented; device validation pending**

The mobile chat client captures rich media natively without `expo-file-system`:

- **Photo selection** via `expo-image-picker` (gallery picker, with
  cancellation and permission-denied states handled).
- **Voice recording** via `expo-audio` with a two-minute auto-stop bound,
  review/playback before send, and discard handling.
- Accessible record/review controls and permission-state UI.

The server upload contract is unchanged, so the existing chat-media tests
still hold. **Not yet proven on real devices:** native photo selection,
permission denial, voice recording, the two-minute auto-stop, review
playback, discard, upload/send failure, and received-media behaviour on both
iOS and Android. Any unexercised platform or physical-device behaviour must
be reported as pending. A real server-side transcription adapter remains a
bounded follow-up: it must stay feature/configuration gated, keep credentials
server-only, and retain a deterministic test/local-development path.

## 10. Handoff summary (AC#9)

### Locally ready

- Complete domain layer (meal planning, chat, grocery requests, suggested cart,
  checkout, push notifications, household isolation)
- Complete server layer (Hono routes, Clerk auth, Drizzle ORM, authorization)
- Complete mobile UI (Member shell, Cook shell, Meal Plan, Chat, Groceries)
- Bilingual system event rendering (English and Hindi)
- Accessibility structural contracts (touch targets, contrast, labels, state)
- Secret-free working tree and git history
- Recovery scenarios for all documented failure modes
- Feature-gated checkout (safe by default, enabled by flag)

### Feature-gated

- Real ordering through Swiggy MCP: `orderingEnabled` flag defaults to false.
  The domain logic, confirmation flow, and audit trail are complete and tested.
  The flag is the single switch for production enablement.

### Requires device validation

- Native Chat photo selection and voice recording/review on iOS and Android
  (implemented in `apps/mobile/src/lib/media.ts`; not yet exercised on devices)
- Real Clerk OTP sign-in on iOS and Android devices
- Manual VoiceOver / TalkBack accessibility, large-text, focus-recovery, and
  reduced-motion checks

### Requires account-level production approval

- Swiggy Instamart production access (staging verification, OAuth callback,
  payment methods, synchronized cart fallback)
- iOS App Store and Google Play approval
- iOS APNs and Android FCM credential provisioning
- Clerk production environment configuration

### Requires human review

- Hindi/Hinglish AI evaluation (meal plan, recipe matching, chat intent)
- Recipe library human review (ingredients, steps, Hindi translations)
- Hindi speech pronunciation review (voice note transcription)
- Privacy copy legal review
