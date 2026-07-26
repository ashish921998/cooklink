# 12 — Deliver role-aware push notifications

**What to build:** Notify Members and Cooks about relevant Household activity
without overwhelming Cooks, leaking payment details, or trusting stale
notification payloads as authorization.

**Blocked by:** 04 — Connect the Household through text Chat; 05 — Edit the
Weekly Meal Plan from either role; 08 — Turn Cook messages into Member-approved
Grocery Requests; 11 — Complete confirmed checkout and order recovery.

**Status:** ready-for-agent

- [ ] New Household memberships default Members to All activity and Cooks to
      Important only.
- [ ] Each person can choose a default per role and override a Household with
      All activity, Important only, or Muted.
- [ ] Meal, Grocery Request, Chat, membership, checkout-failure, and
      delivery-critical events follow the resolved role-aware priority rules.
- [ ] Several events from one Household collapse into one updating
      notification without losing the durable timeline.
- [ ] Actors do not receive push for their own action.
- [ ] Payment amounts, totals, and sensitive checkout details never appear in
      notification previews.
- [ ] Opening a notification re-authorizes current membership and fetches live
      state before showing protected content.
- [ ] Invalid device tokens are retired, and muted notifications preserve
      correct in-app unread and system-event state.

