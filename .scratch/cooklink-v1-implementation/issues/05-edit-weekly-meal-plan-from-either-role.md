# 05 — Edit the Weekly Meal Plan from either role

**What to build:** Let Members and Cooks inspect and effortlessly correct the
active Weekly Meal Plan through the same durable plan model, with clear
conflict recovery, attributed Chat updates, and Household-scoped learning.

**Blocked by:** 04 — Connect the Household through text Chat.

**Status:** ready-for-agent

- [ ] Members and Cooks can view all seven days and open each planned meal from
      their role-specific navigation.
- [ ] A participant can swap meals, search and replace one meal, regenerate one
      meal or future range, and change a per-meal Serving Count.
- [ ] Changes apply immediately without a plan-approval state and create
      concise attributed Household Chat events.
- [ ] A stale edit cannot overwrite a newer version; the current meal is shown
      and fresh confirmation is required.
- [ ] Regeneration does not rewrite past meals or overwrite intentional edits
      unless the person explicitly includes them.
- [ ] Confirmed replacements, repeated selections, Cook edits, and optional
      feedback update only that Household's learning signals.
- [ ] Meal changes recalculate future grocery consequences but never authorize
      an order.
- [ ] English and Hindi plan labels remain usable at the largest supported text
      size.

