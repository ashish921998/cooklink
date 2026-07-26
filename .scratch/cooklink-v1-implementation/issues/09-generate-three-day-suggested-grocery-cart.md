# 09 — Generate the three-day Suggested Grocery Cart

**What to build:** Give Members an editable three-day grocery proposal derived
from planned recipes, delivered orders, expected consumption, freshness, and
approved Cook requests—without asking anyone to maintain exact inventory.

**Blocked by:** 05 — Edit the Weekly Meal Plan from either role; 08 — Turn Cook
messages into Member-approved Grocery Requests.

**Status:** ready-for-agent

- [ ] Completed or delivered orders add only dependable normalized quantities;
      checkout success alone does not update Estimated Pantry.
- [ ] Planned recipe consumption is deducted at meal time and recalculated
      after structured plan changes.
- [ ] Perishable availability degrades through deterministic freshness windows
      and unnormalizable data becomes unknown rather than invented.
- [ ] Approved Grocery Requests override optimistic availability assumptions.
- [ ] The Suggested Grocery Cart covers today and the next two calendar days
      and explains the affected meal and need day for every line.
- [ ] Uncertain items appear as Check at home and can be kept or removed without
      opening a separate pantry screen.
- [ ] Optional Member removal reasons improve later estimates without requiring
      routine stock entry.
- [ ] Household isolation and deterministic quantity/freshness behaviour are
      covered by durable integration tests.

