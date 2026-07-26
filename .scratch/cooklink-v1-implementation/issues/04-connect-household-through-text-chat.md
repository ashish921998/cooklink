# 04 — Connect the Household through text Chat

**What to build:** Give Members and Cooks one reliable Household Chat where
they can exchange text, see attributed system activity, recover from temporary
offline conditions, and maintain independent unread state without introducing
direct messages or extra groups.

**Blocked by:** 03 — Invite Members and Cooks into role-aware navigation.

**Status:** ready-for-agent

- [ ] A Member can open Household Chat from every Member destination and return
      to the destination that opened it.
- [ ] Selecting a Household as a Cook opens its Chat with Chat, Meal Plan, and
      Groceries as the only persistent destinations.
- [ ] Active participants can send, receive, edit, and delete their own text
      messages within the specified lifecycle.
- [ ] The timeline combines human messages and safely rendered attributed
      system events in stable server order.
- [ ] Open Chat refreshes by cursor, supports pull-to-refresh, and maintains
      per-person unread position.
- [ ] Offline messages show Sending, Sent, or Failed state and cannot become
      visible or actionable to others before server acceptance.
- [ ] Historical messages remain attributed after a participant leaves, while
      removed participants immediately lose Chat access.
- [ ] Authorization tests cover timeline, message mutation, unread state, and
      cross-Household denial.

