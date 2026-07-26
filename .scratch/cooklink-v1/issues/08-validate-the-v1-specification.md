# Validate the complete Cooklink V1 specification

Type: prototype
Status: resolved
Blocked by: 04, 05, 06, 07

## Question

Does a concrete end-to-end specification and low-fidelity journey prototype cover the first-use magic, Member and multi-Household Cook experiences, automatic plan editing, Recipe Guides, chat, Grocery Requests, Estimated Pantry, Instamart checkout and fallback, failures, accessibility, and measurable acceptance criteria well enough to hand directly to implementation?

## Validation decisions

### First-use ownership and sequence

The first person who signs in with phone OTP creates the Household and becomes
its Household Owner. They provide only Household name/photo, Serving Count,
Meal Style, and the basic Vegetarian/Eggetarian/Non-vegetarian preference.
Cooklink generates and activates the first Weekly Meal Plan before asking them
to invite Household Members or Cooks. Invitations remain available immediately
after the plan appears.

### First-plan performance

Cooklink displays generation progress immediately and activates a usable
seven-day plan within 15 seconds on a normal network. If personalized
generation misses that deadline, Cooklink activates a safe starter plan and
continues refinement without blocking the Household Owner.

### Household Invite acceptance

The Household Owner creates a role-specific, phone-bound Household Invite and
shares its single-use link through WhatsApp. The recipient must sign in with
the matching phone number and OTP. An invite expires after seven days and may
be revoked before acceptance. An existing Cook who accepts another invite sees
the Household added to the normal Household list, subject to two active Cooks
per Household and 30 active Households per Cook.

### Recipe Guide source

V1 uses a focused, human-reviewed base library of familiar North and South
Indian home recipes. AI may adapt a verified base recipe to the selected
language, Serving Count, and simple Household preferences. When a person adds
an unsupported dish, Cooklink may create a clearly marked AI-generated draft
that a Cook or Household Member can correct; it is not presented as a verified
recipe.

### Recipe scaling and accuracy

Verified recipes store dependable ingredient quantities at a base Serving
Count. Cooklink scales those quantities deterministically for the planned
Serving Count. Salt, oil, spices, water, and other judgement-based ingredients
use approximate ranges or “adjust to taste” guidance and do not create false
precision in Estimated Pantry calculations.

### Uncertain pantry presentation

V1 has no standalone pantry-management screen. When an ingredient is needed
for the three-day horizon but its Estimated Pantry state is uncertain, the
Suggested Grocery Cart includes it with a plain “Check at home” label and the
upcoming meal that needs it. A Household Member keeps or removes it during
normal cart review.

### Unavailable-product replacement

An unavailable Instamart product blocks checkout for that cart line. Cooklink
offers up to three currently available alternatives showing exact brand,
variant, pack size, and price. A Household Member must deliberately choose a
replacement or remove the item before checkout; Cooklink never substitutes
silently.

### Payment-method selection

Cooklink shows only the payment methods returned by the current Instamart cart.
One available method is shown and may be preselected; when several are
available, the Household Member chooses one. If none is available, checkout
continues in Instamart. Cooklink never collects or stores payment credentials,
and the selected method is displayed before fresh checkout confirmation.

### Accessibility baseline

V1 follows native iOS and Android accessibility conventions with WCAG 2.2 AA
as a supporting baseline. Critical journeys are manually tested with VoiceOver
and TalkBack. Normal text meets 4.5:1 contrast; large text and meaningful
controls meet 3:1. Controls meet 44-by-44-point iOS or 48-by-48-dp Android
minimum targets. The largest supported system text reflows or scrolls without
hiding actions, and status never relies on colour alone. Dynamic changes,
errors, confirmations, and checkout results use accessible announcements and
focus recovery. Reduced motion is respected.

Recipe Guide text is the accessible equivalent of generated recipe audio.
Voice-note transcripts are exposed when transcription succeeds, but uncertain
transcripts are labelled and remain correctable rather than authoritative.
Navigation and recovery use plain English or Hindi, consistent placement, and
icon-plus-text controls.

### Member and Cook identity

One phone-authenticated account may be a Household Member in one Household and
a Cook in other Households. The app exposes two plain areas, “My home” and
“Work households,” when both apply and remembers the last area used. A person
holds exactly one role within a given Household, so permissions and entry
navigation are never ambiguous.

## Answer

Yes. The 21-stage journey prototype exposed eight gaps; live validation
resolved first-use ownership and timing, invite acceptance, Recipe Guide
provenance and scaling, uncertain pantry presentation, unavailable-product
replacement, payment-method selection, accessibility, and Member/Cook
identity. The synchronized-cart fallback question was already answered by the
Instamart research.

The implementation-ready result is [Cooklink V1 specification](../spec.md).
The [V1 journey prototype](../../../prototype/v1-journey/) remains
primary-source evidence for the validated journeys and previously exposed
gaps.
