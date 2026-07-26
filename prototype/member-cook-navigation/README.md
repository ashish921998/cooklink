# Member and Cook navigation prototype

> PROTOTYPE — throw this route away after the navigation decision is captured.

Three variants of Cooklink's Member and Cook navigation model, switchable with
`?variant=A`, `?variant=B`, or `?variant=C`, on the standalone prototype route.

Run it:

```sh
npm run prototype:navigation
```

Then open [http://localhost:4173/?variant=A](http://localhost:4173/?variant=A).

The prototype is read-only. Role, selected Household, and current destination
live only in memory. Variant selection lives in the URL so a comparison can be
shared or reloaded.

## Outcome

**Variant A — Three clear places was selected.**

It keeps Members on Today, Meal Plan, and Groceries; keeps Cooks on a
WhatsApp-like Household list; and opens each Cook Household on Chat with Chat,
Meal Plan, and Groceries as its three persistent destinations. Today's cooking
is a pinned card inside Chat rather than a fourth destination.

The product decision and implementation contract are recorded in
[`03-prototype-member-and-cook-navigation.md`](../../.scratch/cooklink-v1/issues/03-prototype-member-and-cook-navigation.md).

## What each variant tests

- **A — Three clear places:** persistent bottom destinations inside a Household.
- **B — Chat with shortcuts:** Meal Plan and Groceries are large actions within
  today's/chat context rather than app-level destinations.
- **C — One Household, three views:** Chat, Meal Plan, and Groceries are a
  segmented switcher at the top of a selected Household.
