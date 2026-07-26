# 13 — Prove the accessible V1 journey and release gates

**What to build:** Demonstrate the complete V1 on iOS and Android with the
agreed accessibility, localization, security, failure-recovery, and provider
gates, clearly separating locally proven behaviour from external production
approval.

**Blocked by:** 03 — Invite Members and Cooks into role-aware navigation; 05 —
Edit the Weekly Meal Plan from either role; 06 — Add private photo and
voice-note Chat; 07 — Provide verified bilingual Recipe Guides; 09 — Generate
the three-day Suggested Grocery Cart; 11 — Complete confirmed checkout and
order recovery; 12 — Deliver role-aware push notifications.

**Status:** ready-for-agent

- [ ] The end-to-end Owner, Member, multi-Household Cook, meal, Chat, request,
      cart, checkout, fallback, and recovery journeys pass on iOS and Android.
- [ ] Critical journeys pass manual VoiceOver and TalkBack testing, largest
      supported text, contrast, touch-target, non-colour-state, focus recovery,
      and reduced-motion checks.
- [ ] English and Hindi navigation, system events, Recipe Guides, errors, and
      dynamic layouts are verified on representative narrow devices.
- [ ] Automated tests prove Household isolation for every scoped record,
      action, media object, transcript, suggestion, cart, and order.
- [ ] The mobile bundle and repository history checks contain no provider
      secret, service credential, database key, or plaintext OAuth token.
- [ ] Checkout failure, uncertain result, partial success, offline outbox,
      expired invite, removed membership, and unavailable-product recovery are
      demonstrated.
- [ ] Swiggy staging, OAuth callback approval, payment behaviour, synchronized
      cart fallback, and production access are reported as passed, failed, or
      externally blocked—never assumed.
- [ ] Hindi/Hinglish AI evaluation, recipe-library human review, Hindi speech
      pronunciation review, notification credentials, and privacy copy have
      explicit release evidence.
- [ ] The handoff states exactly what is locally ready, what is feature-gated,
      and what still requires account-level production approval.
