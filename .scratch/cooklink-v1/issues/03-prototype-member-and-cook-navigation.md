# Prototype the Member and Cook navigation model

Type: prototype
Status: resolved
Blocked by:

## Question

What is the smallest understandable mobile information architecture in which Members land on Today's Meals, Cooks land on a WhatsApp-like Household list, each Household opens chat-first for Cooks, and Meal Plan and Groceries remain obvious without introducing a dashboard or overwhelming low-literacy users?

## Answer

Use Variant A, **Three clear places**, with a different entry shell for each
role and no dashboard:

- A Household Member opens their active Household on **Today's Meals**. The
  persistent bottom destinations are **Today**, **Meal Plan**, and
  **Groceries**. Household Chat is a header action, not a fourth tab.
- A Cook opens the **Household list**. Selecting a Household opens its
  **Household Chat**. Within that selected Household, the persistent bottom
  destinations are **Chat**, **Meal Plan**, and **Groceries**.
- The Cook's current meal is a pinned **Today's cooking** card at the top of
  Household Chat. It opens the Daily Cook View without creating another
  persistent destination.
- A visible back action from any Cook Household returns to the Household list.

This keeps every recurring destination in the same place, keeps the Cook's
cross-Household context separate from their within-Household work, and limits
each persistent navigation bar to three labelled choices.

The role control and variant switcher in the prototype are evaluator controls.
They do not ship in the product.

## Why Variant A won

- **Variant B — Chat with shortcuts** made Meal Plan and Groceries visually
  prominent, but their position changed between Today's Meals and Household
  Chat. That requires users to relearn where the same action lives.
- **Variant C — One Household, three views** was compact, but the segmented
  control crowded the Household header and competed with the back action and
  Household identity.
- **Variant A** uses familiar bottom navigation only where a person has entered
  a stable context. It does not add a generic Home or Dashboard destination.

## Navigation contract

### Member entry shell

```text
Active Household
├── Today                 default after launch
│   ├── Planned meal
│   └── Recipe Guide
├── Meal Plan             seven-day plan
├── Groceries             requests, suggested cart, orders
└── Household Chat        header action; pushed over the current tab
```

- Launch and successful sign-in resolve the Household Member to the active
  Household's Today destination.
- Switching among Today, Meal Plan, and Groceries does not change Household
  context.
- Opening Household Chat preserves the invoking tab. Back returns to that tab.
- Household Chat may show unread state on its header action, but it does not
  become a fourth bottom destination.

### Cook entry shell

```text
Households                default after launch
└── Selected Household
    ├── Chat              default after Household selection
    │   └── Daily Cook View
    ├── Meal Plan
    └── Groceries         Grocery Requests only; no purchasing authority
```

- Launch and successful sign-in resolve a Cook to the Household list, including
  when the Cook belongs to only one Household. Do not auto-open the sole
  Household; the list is the Cook's stable cross-Household home.
- A Household row shows Household identity, the next relevant planned meal, a
  recent activity preview, and any unread count. Detailed ordering and
  notification priority remain owned by issue 06.
- Selecting a Household always opens Chat, even if the Cook last viewed Meal
  Plan or Groceries there.
- The selected Household's Chat, Meal Plan, and Groceries destinations retain
  their local UI state while the Cook remains in that Household.
- Back from any selected-Household destination returns to the Household list.
- Selecting a different Household creates a clean Household-scoped navigation
  context; content or draft state must never leak between Households.

### Expo Router shape

The implementation may change file names to match the final app structure, but
it must preserve this route hierarchy:

```text
app/
├── (member)/
│   └── households/[householdId]/
│       ├── (tabs)/
│       │   ├── today
│       │   ├── meal-plan
│       │   └── groceries
│       ├── chat
│       └── recipes/[plannedMealId]
└── (cook)/
    └── households/
        ├── index
        └── [householdId]/
            ├── (tabs)/
            │   ├── chat
            │   ├── meal-plan
            │   └── groceries
            └── today
```

- The membership role chooses the entry shell; a product-wide role toggle is
  not part of this navigation.
- Every Household route requires an authorized `householdId`; the client must
  not treat a route parameter as authorization.
- Policy for an identity that legitimately has both Cook and Household Member
  memberships is outside this prototype and must be resolved with
  authentication and membership rules before implementation.

## Navigation-level states

### Cook Household list

- **No Households:** explain that the Cook joins through a Household Invite. If
  an invite is pending, expose that one invite; otherwise do not invent an
  action or show empty navigation tabs.
- **One Household:** show the normal list with one row. Do not introduce a
  special layout or skip the list.
- **Many Households:** use the same row structure up to 30 active Households and
  provide text search at the top.
- **Unread activity:** show a count on the relevant Household row. The row
  remains a single tap target that opens Chat.
- **Loading:** show stable row placeholders; do not briefly auto-open a cached
  Household.
- **Unavailable:** keep the list visible when possible and give one plain
  retry action.

### Selected Cook Household

- **No messages:** Chat still opens first, with the pinned Today's cooking card
  when a meal exists and a plain prompt to send the first message.
- **No planned meal today:** replace the pinned card with “No meals planned
  today” and a labelled action to open Meal Plan.
- **Pending Grocery Requests:** show a count on Groceries and the corresponding
  automatic update in Household Chat; the Cook cannot approve or purchase.
- **Two Cooks:** both Cooks use the same Household Chat and same Household
  destinations. Do not add Cook-specific threads or a Cook picker.
- **Membership removed or access revoked:** discard Household-scoped state,
  leave the Household route, return to the Household list, and explain that
  access changed.

### Member Household

- **No planned meal today:** Today remains the landing destination and offers
  one action to open Meal Plan.
- **Unread Household Chat:** show a restrained unread indicator on the header
  action.
- **Pending Grocery Requests:** show a count on Groceries; approval and ordering
  occur only in the Member Groceries destination.
- **Household unavailable:** keep the user out of Household content and resolve
  through the authenticated membership boundary rather than displaying stale
  data.

### Language and comprehension

- Navigation uses an icon plus a short text label for every persistent
  destination.
- Labels are localized into the selected English or Hindi locale; do not show
  both languages simultaneously in the navigation bar.
- Use the canonical labels Today, Meal Plan, Groceries, Chat, and Households.
  Do not introduce Home, Dashboard, Menu, or Workspace synonyms.
- A visible control has at least a platform-equivalent 44-point iOS or 48-dp
  Android touch target and a programmatic accessibility label.

## Acceptance criteria

1. Given a signed-in Household Member, a fresh launch opens the active
   Household's Today destination with Today selected.
2. The Member can reach Meal Plan and Groceries with one tap from any Member
   bottom destination.
3. Household Chat is reachable from every Member bottom destination without
   adding a fourth bottom tab, and back returns to the invoking destination.
4. Given a signed-in Cook, a fresh launch opens the Household list, including
   when exactly one Household is available.
5. Selecting any Household from the Cook list opens that Household's Chat with
   Chat selected.
6. The selected Cook Household exposes exactly three persistent destinations:
   Chat, Meal Plan, and Groceries.
7. The pinned Today's cooking card opens the Daily Cook View without changing
   the three persistent destinations.
8. A visible back action from every selected Cook Household returns to the
   Household list.
9. Switching between two Households never displays the previous Household's
   messages, plan, requests, drafts, unread state, or title.
10. A Cook can describe a Grocery Request but cannot see an approval, cart, or
    checkout action.
11. No Member or Cook route is labelled Home or Dashboard, and no hamburger
    menu is required to discover Meal Plan or Groceries.
12. The route hierarchy behaves consistently in English and Hindi at 320
    logical pixels wide and with the largest supported system text scale.

## Prototype source

The throwaway comparison lives in
[`prototype/member-cook-navigation`](../../../prototype/member-cook-navigation/).
Variant A is selected; Variants B and C remain useful only as primary-source
evidence for the rejected tradeoffs.
