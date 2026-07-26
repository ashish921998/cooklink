# Cooklink V1 journey prototype

> PROTOTYPE — throw this away after the V1 spec is validated. The validated
> decision and any gap-closures land in
> [`08-validate-the-v1-specification.md`](../../.scratch/cooklink-v1/issues/08-validate-the-v1-specification.md).

A low-fidelity, clickable end-to-end journey through Cooklink V1, built to
answer the question in
[issue 08](../../.scratch/cooklink-v1/issues/08-validate-the-v1-specification.md):

> Does a concrete end-to-end specification and low-fidelity journey prototype
> cover the first-use magic, Member and multi-Household Cook experiences,
> automatic plan editing, Recipe Guides, chat, Grocery Requests, Estimated
> Pantry, Instamart checkout and fallback, failures, accessibility, and
> measurable acceptance criteria well enough to hand directly to
> implementation?

This is **not** a "three variants of one screen" prototype like the navigation
one. It is a single coherent journey that walks every surface the spec must
cover. Its job is to make gaps visible: **wherever the spec goes silent, the
stage renders an explicit "⚠ Spec gap" callout** — that gap is the finding.

## Validation outcome

The prototype completed its purpose. Live review resolved every gap listed
below, and the implementation-ready result is
[`Cooklink V1 specification`](../../.scratch/cooklink-v1/spec.md). The callouts
remain in this throwaway prototype as primary-source evidence of what the
validation found; they no longer represent open Wayfinder decisions.

## Run it

```sh
npm run prototype:journey
```

Then open
[http://localhost:4174/?stage=firstuse-welcome&lang=en&coverage=0](http://localhost:4174/?stage=firstuse-welcome&lang=en&coverage=0).

State lives only in memory. `stage`, `lang`, and `coverage` live in the URL so a
comparison can be shared or reloaded.

## Controls

- **Bottom bar** ← / → — step through the 21 stages of the journey (or use the
  `←` / `→` arrow keys).
- **Top bar EN / हिं** — toggle English / Hindi on every stage (`l` key). This
  exercises the i18n requirement and the low-literacy lens.
- **Criteria button** — open the **acceptance-coverage overlay** (`c` key). It
  lists the synthesized V1 acceptance criteria (rolled up from issues 01–07)
  and highlights the ones the *current* stage demonstrates in green. The full
  list is the measurable V1 acceptance bar.
- The corner readout shows the current stage key, language, and mapped AC ids
  (or "no AC mapped (gap)").

## The 21 stages

| Section | Stages |
| --- | --- |
| First-use | create household · plan appears (no approval) · invite cook |
| Member loop | today · meal-plan edit tools · concurrency conflict · recipe guide |
| Chat | text/photo/voice · private intent suggestion · approve Cook request |
| Cook loop | household list · chat-first + Daily Cook View · create grocery request |
| Groceries | suggested cart + estimated pantry · checkout (exact cart + fresh confirm) · ₹1000+ fallback |
| Failures | checkout retry via get_orders · offline outbox · membership removed |
| Accessibility | Hindi locale + largest text scale |
| Spec gaps | dual identity (Member + Cook) |

## Spec gaps surfaced (the actual findings)

Every stage that hit a genuine hole renders a callout. The recurring themes:

1. **First-use / Household creation** — who the first person becomes (Household
   Owner), how the screen is reached after phone-OTP, and the Household Invite
   acceptance path (phone binding, two-Cook cap, cross-household onboarding for
   an existing Cook) are all undefined.
2. **"First-use magic" is asserted, not measurable** — no target like "first
   plan generated within T+10s of setup."
3. **Recipe Guide content model is unspecified** — the spec fixes the delivery
   channel (text + on-demand TTS) but not where the steps come from (AI /
   curated / Cook-authored), the accuracy standard, or Serving-Count scaling.
4. **Estimated Pantry vocabulary is fixed, interpretation is not** — what a
   user does with `unknown`, and how perishable freshness-window degradation
   renders on screen, are undefined.
5. **Checkout substitution UX and payment-method selection** are undefined at
   the user level, despite "exact cart review" being mandated.
6. **"Synced cart" in the Instamart fallback** is undefined — does Instamart
   actually receive it?
7. **Accessibility is one AC** (44pt targets + largest text scale) — no
   VoiceOver/TalkBack, contrast, or low-vision plan, which matters for a
   low-literacy audience.
8. **Dual identity (Member + Cook)** — the single explicitly-deferred decision
   in V1 (issue 03). It breaks the entry-shell choice and must be resolved
   before implementation.

## What this prototype does NOT do

- No real data, no backend, no persistence (per the prototype skill).
- No production assets — it reuses the navigation prototype's throwaway
  visual language (DM Sans/Serif, leaf/mango/cream palette, SVG icons).
- The Hindi strings are representative, not a complete localization pass.
