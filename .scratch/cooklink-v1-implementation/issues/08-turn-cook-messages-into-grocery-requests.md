# 08 — Turn Cook messages into Member-approved Grocery Requests

**What to build:** Let a Cook naturally describe a missing ingredient in text
or speech, privately confirm Cooklink's interpretation, and create a structured
Grocery Request that Members can deliberately approve, reject, order now, or
defer.

**Blocked by:** 05 — Edit the Weekly Meal Plan from either role; 06 — Add
private photo and voice-note Chat.

**Status:** ready-for-agent

- [ ] English, Hindi, and code-mixed messages can suggest a Grocery Request
      without requiring the Cook to choose an Instamart product or urgency.
- [ ] Missing essential information triggers one plain follow-up question
      rather than a form.
- [ ] A detected action remains private to its author until explicitly
      confirmed.
- [ ] Confirmation rechecks membership and current state before creating the
      pending request and attributed Chat event.
- [ ] Similar concurrent requests are shown with Update quantity or Keep
      separate; they are never silently merged.
- [ ] Either active Cook may update or cancel a pending request, but cannot
      change it after Member approval.
- [ ] Members can approve, reject, order immediately, or leave the request for
      the next Suggested Grocery Cart.
- [ ] No Chat or Grocery Request action can bypass exact cart review and fresh
      Member checkout confirmation.

