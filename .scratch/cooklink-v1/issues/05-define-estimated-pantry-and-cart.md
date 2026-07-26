# Define Estimated Pantry and three-day grocery suggestions

Type: grilling
Status: resolved
Blocked by: 01, 04

## Question

What deterministic quantity, timing, uncertainty, and reconciliation rules should add completed Instamart orders, subtract expected recipe consumption, incorporate approved Cook Grocery Requests, and produce an editable Suggested Grocery Cart for the next three days without routine inventory entry or false claims of exact stock?

## Answer

Cooklink maintains an Estimated Pantry, not an inventory ledger. It uses
completed Instamart order data and planned recipe consumption to estimate which
ingredients are likely covered, but it must never claim exact household stock.
The Suggested Grocery Cart is the editable, Member-reviewed buying proposal for
today and the next two calendar days.

## Quantity rules

- Preserve the exact Instamart SKU and package quantity for cart review,
  reorder matching, provider checkout, and order history.
- Normalize purchased quantities into recipe units only for internal estimation:
  grams for mass, millilitres for volume, and count for discrete items.
- Recipe consumption subtracts from normalized internal quantities, not from
  user-facing SKU labels.
- When a SKU cannot be reliably normalized, keep the item usable for reorder
  and cart display, but mark its pantry confidence as `unknown` or `may be low`
  rather than inventing precision.
- Do not show pantry balances such as "250g left" or "2 onions remaining" in
  V1. Numeric quantities may appear only as cart needs or purchased package
  sizes.

## Order addition rules

- Add purchased quantities to Estimated Pantry only after Instamart reports the
  order as delivered or otherwise completed.
- Checkout success alone does not add pantry quantities, because items may be
  cancelled, substituted, partially fulfilled, delayed, or undelivered.
- Completed orders reset matching ingredients to `likely available`, subject to
  expected consumption and freshness windows.
- Perishable ingredients degrade deterministically after freshness windows.
  Example: milk, paneer, coriander, and fresh vegetables should not remain
  `likely available` indefinitely.
- Non-perishable ingredients may remain `likely available` until expected
  consumption, cart edits, Grocery Requests, or other corrections reduce
  confidence.

## Consumption rules

- Tentatively subtract expected recipe consumption at the planned meal time.
- Use the planned meal's recipe quantities and Serving Count at that time.
- If the meal is changed, skipped, delayed, or otherwise corrected later,
  reconcile the estimate from the structured meal event.
- Do not require routine "meal completed" entry from the Cook or Household
  Member.
- Regenerate, swap, Serving Count override, and Cook meal edits recalculate
  future expected consumption from the resulting Weekly Meal Plan.

## Uncertainty rules

V1 exposes only qualitative pantry confidence:

- `likely available`
- `may be low`
- `unknown`

Ban user-facing claims that imply exact stock, including:

- `in stock`
- `available at home`
- `you have`
- `left in pantry`
- exact balances such as `250g remaining`

Allowed language includes:

- `estimated`
- `likely available`
- `may be low`
- `unknown`
- `expected need`
- `based on recent orders and planned meals`

## Grocery Request rules

- A Cook's Grocery Request overrides Estimated Pantry for cart suggestion
  purposes.
- If the Cook requests an ingredient, the next relevant Suggested Grocery Cart
  should include that need even when Estimated Pantry currently says the item is
  `likely available`.
- This override affects the cart, not historical pantry math. It is a
  real-world correction signal, but it does not silently rewrite delivered
  order history or imply exact stock.
- Grocery Requests still require Household Member review before checkout. They
  never grant purchasing authority to the Cook.

## Three-day cart horizon

- The Suggested Grocery Cart covers today plus the next two calendar days.
- It is not a rolling 72-hour window.
- Include expected ingredient gaps for planned breakfast, lunch, and dinner in
  that calendar horizon.
- Recalculate when the Weekly Meal Plan changes, Serving Count changes,
  Estimated Pantry changes, Grocery Requests are approved/deferred, or Member
  cart edits are made.

## Timing and delivery-risk rules

- Group or label suggested items by when they are needed: `needed today`,
  `needed tomorrow`, or `needed day after`.
- Account for meal timing so ingredients for an early meal can surface with
  appropriate urgency.
- If checkout fails, delivery is delayed, or an order is partially fulfilled,
  flag the affected planned meals and keep the recovery action in Member
  review.
- Do not expand into automatic ordering, emergency purchase, or Cook-selected
  urgency.

## Member cart edit reconciliation

- A Household Member can edit quantities, remove items, substitute products, add
  products, defer items, or continue through provider fallback when required.
- Removing an item from the Suggested Grocery Cart does not silently mean the
  Household has it at home.
- When a Member removes an item, Cooklink may offer optional reasons such as
  `already have`, `not needed`, or `buy later`.
- If the Member chooses `already have`, update Estimated Pantry confidence
  toward `likely available` for that ingredient.
- If the Member chooses `not needed`, remove the item from this cart and treat
  it as weak evidence against the related current need.
- If the Member chooses `buy later`, defer it from this cart without claiming
  pantry availability.
- If no reason is chosen, the edit affects only the current cart.

## Acceptance criteria

1. Delivered/completed Instamart orders add normalized internal ingredient
   quantities while preserving exact SKU/package details for review and
   checkout.
2. Checkout success alone does not update Estimated Pantry.
3. Expected recipe consumption is tentatively subtracted at planned meal time
   and later reconciled from structured meal changes.
4. The app exposes only `likely available`, `may be low`, and `unknown` pantry
   confidence, never exact pantry balances.
5. Cook Grocery Requests override Estimated Pantry for Suggested Grocery Cart
   inclusion but do not grant Cook purchasing authority.
6. The Suggested Grocery Cart covers today plus the next two calendar days.
7. Cart items can be labelled by need timing and affected meals are flagged
   after checkout, delivery, or fulfilment problems.
8. Member cart removals ask for optional reconciliation reasons and make no
   pantry inference when no reason is provided.
9. Delivered perishables degrade through deterministic freshness windows;
   non-perishables remain likely available until consumption or correction.
10. No rule requires routine inventory entry or makes false claims of exact
    household stock.
