# Define household communication and notification rules

Type: grilling
Status: resolved
Blocked by: 02, 03

## Question

What events, permissions, notification priorities, and lifecycle rules should govern the single Household Chat, text/photo/voice-note messages, automatic meal and grocery system messages, direct Cook meal edits, pending Grocery Requests, two Cooks per Household, and up to 30 Households per Cook?

## Answer

Household Chat is a durable communication and action surface over authoritative
structured records. It is not the source of truth for the Weekly Meal Plan,
Grocery Requests, Suggested Grocery Cart, or Grocery Orders.

English or Hindi text and voice notes may produce a private action suggestion
for the author. Nothing changes until the author explicitly confirms it.
Confirmation performs an authorized, idempotent structured mutation and then
appends an attributed system event to the shared Household Chat.

The default notification level is **role-aware**: **All activity** for a
Household Member and **Important only** for a Cook. Each person chooses a
default per membership role and may override an individual Household with **All
activity**, **Important only**, or **Muted**. When a person holds both
memberships, each membership carries its own default in its own Household
context.

## Non-negotiable model

- One Household has exactly one Household Chat.
- Every active Household Member and Cook in that Household sees the same
  ordered conversation.
- There are no direct messages, Cook-specific threads, participant-created
  groups, typing indicators, reactions, presence, or read receipts in V1.
- Structured records remain authoritative. Editing or deleting a source
  message never silently edits or reverses a confirmed structured action.
- The backend is the only writer of system events.
- Every message, suggestion, event, media object, transcript, and mutation is
  authorized against the Household membership on the server.
- The prototype's Member/Cook switch is not a product control. Permissions are
  determined by the person's role in the selected Household.

## Permission contract

| Capability | Household Owner | Household Member | Cook |
| --- | --- | --- | --- |
| Read Household Chat while membership is active | Yes | Yes | Yes |
| Send text, one photo, or one voice note | Yes | Yes | Yes |
| Edit/delete own human message within 15 minutes | Yes | Yes | Yes |
| Edit/delete another person's message | No | No | No |
| Edit the Weekly Meal Plan | Yes | Yes | Yes |
| Confirm a Chat-suggested Meal Plan change | Yes | Yes | Yes |
| Create a Grocery Request | No | No | Yes |
| Edit/cancel a pending Grocery Request | No | No | Either active Cook |
| Approve/reject a pending Grocery Request | Yes | Yes | No |
| Add an item to the Suggested Grocery Cart | Yes | Yes | No |
| Review/place a Grocery Order | Yes | Yes | No |
| Manage Household membership | Yes | No | No |
| Configure own notification preferences | Yes | Yes | Yes |

After a Grocery Request is approved, Cooks cannot edit or cancel it. Household
Members manage the resulting cart item in Groceries. Cooks receive only the
request status they need; they do not receive Member-only price, payment, or
checkout controls.

## Human messages

### Supported message shapes

- Plain text.
- One photo, optionally with one text caption.
- One voice note up to two minutes.
- No mixed or multiple attachments in one message.
- Photos are compressed before upload. V1 does not analyze image contents.
  Photos are human communication, not system input. Text intent detection may
  use the photo caption. Adding or editing a caption within the 15-minute edit
  window re-runs intent detection, mirroring a corrected voice transcript.

### Voice notes and language

- Voice transcription supports English and Hindi.
- The transcript stays in the language spoken; Cooklink does not translate
  human messages.
- A collapsed **View transcript** action exposes the automatic transcript to
  every authorized participant and labels it as automatic.
- The author may correct the transcript during the message's 15-minute edit
  window.
- Correcting the transcript re-runs intent detection against the corrected
  text, because recognition errors are expected. Any resulting suggestion
  remains private to the author until confirmed and follows the normal 24-hour
  expiry.
- Intent detection may use the transcript, but any suggested structured action
  remains private to the author until confirmed.

### Send, edit, and delete lifecycle

- A local, Household-scoped outbox shows **Sending**, **Sent**, or **Failed**.
- Text and media retry automatically when connectivity returns. A person may
  cancel or manually retry a pending item.
- A pending message is never visible to other participants and cannot produce
  an action suggestion until the server accepts it.
- Server acceptance time determines the message's position in the shared
  timeline; the client-created time may be retained for diagnostics.
- A person may edit or delete their own human message for 15 minutes after
  server acceptance.
- An edit is labelled **Edited**. A deletion leaves **Message deleted** in the
  timeline.
- Deleting a photo or voice note revokes access to its media immediately and
  schedules the private object for deletion. The tombstone remains.
- System events cannot be edited or deleted by Household participants.
- Editing or deleting a source message invalidates any unconfirmed suggestion.
  A previously confirmed Meal Plan, Grocery Request, or Suggested Grocery Cart
  mutation remains and must be changed through its structured destination.

## Chat-assisted structured actions

### Intent flow

1. The backend accepts a human text, photo caption, or voice note.
2. Cooklink detects a possible intent in English or Hindi.
3. If an essential detail is missing, Chat asks only for that detail in the
   author's selected language.
4. Cooklink shows a private suggestion to the author.
5. The author explicitly confirms or dismisses it.
6. The server re-authorizes the membership, validates current structured state,
   and performs an idempotent mutation.
7. On success, the backend appends one attributed system event visible to the
   Household.
8. On failure or conflict, the suggestion remains actionable with a plain
   explanation and Retry or Review action; no duplicate record is created.

Private suggestions survive app restarts and expire when acted on, dismissed,
the source changes, or 24 hours pass. They are never included in another
participant's Chat or notification stream.

### Grocery intent

- A Grocery Request requires an identifiable item. Quantity is optional.
- “नारियल चाहिए” can produce **Create Grocery Request: नारियल**.
- “मुझे किराना चाहिए” or “I need grocery” asks **क्या चाहिए?** or
  **What do you need?** before offering confirmation.
- For a Cook, confirmation creates a pending Grocery Request.
- For a Household Member, the same intent offers **Add to Suggested Cart** and
  creates a Member-authorized Suggested Grocery Cart item. It never creates a
  provider cart side effect or bypasses Groceries review.
- A Household Member may approve a Cook's request from its live Chat card with
  **Approve and add to Suggested Cart**. Product matching, quantity,
  substitution, price review, and checkout remain in Groceries.
- Either active Cook may edit or cancel a pending Grocery Request. Every action
  records its actor.
- Grocery Request mutations between Cooks use optimistic concurrency, mirroring
  Meal Plan. On commit, if the request changed since the Cook opened it, the
  mutation is rejected and Chat shows the current state with the actor who
  changed it (for example, "Cook B set quantity to 5" or "Cook B cancelled
  this") and requires fresh confirmation. There is no silent last-write-wins,
  and a cancelled request is never resurrected.
- When a similar pending request exists, or two Cooks create similar requests
  near-simultaneously, the similarity check runs at commit and Chat offers
  **Update quantity** or **Keep separate** rather than emitting a duplicate.
  Cooklink never merges requests silently.

### Meal Plan intent

- A Meal Plan change needs a day, meal slot, and replacement meal.
- Chat asks only for a missing day or meal slot. It never silently chooses the
  next likely meal.
- Cooks and Household Members use the same explicit confirmation flow because
  both roles may edit the Weekly Meal Plan.
- Confirmation uses optimistic concurrency. If the meal changed after the
  suggestion was created, Chat shows the current meal and requires fresh
  confirmation rather than applying last-write-wins.
- One changed meal creates one system event. A bulk regeneration or multi-meal
  edit creates one summary event such as “Meera updated 12 meals,” with
  **View Meal Plan**.

## System events and live cards

A system event is an immutable, attributed record of a meaningful structured
transition. A related card renders the structured entity's current status, so
Chat preserves history without displaying stale controls.

V1 event families are:

- `meal.changed`
- `meal_plan.bulk_updated`
- `grocery_request.created`
- `grocery_request.updated`
- `grocery_request.cancelled`
- `grocery_request.approved`
- `grocery_request.rejected`
- `grocery_request.in_order`
- `grocery_request.fulfilled`
- `grocery_order.placed`
- `grocery_order.failed`
- `grocery_order.delivery_updated`
- `membership.joined`
- `membership.removed`

Rules:

- Events store a type, actor, Household, structured entity reference, safe
  rendering payload, and server timestamp. Do not persist one pretranslated
  sentence as the event.
- The safe rendering payload carries status transitions only. It never includes
  payment amounts, order totals, or prices. Amounts live only in the
  Member-controlled Groceries surfaces, so Chat history is safe for every role
  at any time, including a newly joined Cook reading prior history.
- The client renders Cooklink-authored event text in each viewer's selected
  English or Hindi locale.
- Grocery Request transitions append concise attributed events. Related cards
  always render the current request status and only actions the viewer is
  authorized to perform.
- Bulk operations create one event and at most one notification.
- Routine internal synchronization, transcript generation, preference changes,
  and media processing do not create Chat events.
- The actor does not receive a push for their own action, though its event
  remains visible in Chat.

## Notification contract

### Preference model

Each person has:

- one default **per membership role** (All activity for a Household Member,
  Important only for a Cook) applied to new Households of that role;
- an optional override for each Household;
- a preview preference for each registered device.

The three Household levels are:

| Level | Push behavior |
| --- | --- |
| **All activity** | Every human message and every system event visible to that role |
| **Important only** | Human messages plus the role-aware events below |
| **Muted** | No Household push; in-app unread and action badges still update |

The default is role-aware: **All activity** for a Household Member, **Important
only** for a Cook. All activity remains the ceiling either role may opt into
per Household.

Important-only events for a Household Member:

- human messages;
- same-day Meal Plan changes;
- new, updated, or cancelled Grocery Requests;
- checkout failures;
- delivery-critical Grocery Order updates;
- membership/access changes affecting the person.

Important-only events for a Cook:

- human messages;
- same-day Meal Plan changes;
- Grocery Request approval, rejection, cancellation, in-order, or fulfilment;
- a Grocery Request created by another active Cook in the same Household;
- membership/access changes affecting the person.

Routine future-plan changes, weekly regeneration, cart preparation, and
non-critical Grocery Order updates remain visible in Chat without an
important-only push.

### Delivery and privacy

- Several events from one Household in a short burst collapse into one updating
  notification for that Household. The full timeline remains intact.
- Opening a notification re-authorizes the membership and fetches current data;
  the payload never grants access.
- Full message or action details appear in previews by default.
- Payment, checkout, order-failure, and amount content is **always redacted**
  in previews regardless of the preview setting, for example **Checkout needs
  attention** with no amount. This is hard-gated before the outbound payload is
  built and does not depend on the user finding a toggle.
- A person may hide previews independently on any device. That device then
  shows only generic text such as **New Cooklink activity**.
- Notification-level preferences sync across a person's devices; preview
  visibility is device-specific.
- A device actively viewing the affected Household Chat does not show a
  redundant foreground push.
- Stale or rejected push tokens are removed.

This full-preview default supersedes the conservative no-sensitive-preview
recommendation in [issue 02](02-verify-expo-platform-feasibility.md) for
coordination content (chat, meals, grocery requests), because readable previews
materially help low-literacy Members. It still honors issue 02's concern for
the payment-sensitive class: money, checkout, and order amounts are never
placed in a preview or passed through a push provider. For the remaining
content, when previews are enabled, push providers necessarily receive that
display text. The architecture and privacy copy must disclose that tradeoff and
must honor the per-device hide-preview setting before constructing the
outbound payload.

## Unread state and Cook Household ordering

- Track a private last-read position for each person and Household. Do not
  expose it as a read receipt.
- Opening Chat marks human messages and attention-requiring system events
  through the latest visible point as read.
- Pending action badges are derived from structured state and do not clear when
  Chat is opened.
- Routine system events remain in the timeline but do not add unread debt.
- A Cook's Household row moves upward for a new human message or an action
  requiring that Cook's attention.
- Routine background system events do not reshuffle up to 30 Household rows.
- Each row may show Household identity, next relevant meal, latest
  attention-worthy preview, timestamp, and unread count.
- Search remains available across Household names. Notification preference does
  not hide a Household or remove its unread state.

## Membership, history, and retention

- Chat history is retained for the lifetime of the Household.
- A newly authorized Household Member or Cook may read prior Household history.
- Removing a membership revokes Chat, transcript, media, and notification
  access immediately. Queued messages from that membership fail permanently
  with **Household access changed**.
- Historical messages and events remain attributed after their actor leaves;
  the UI labels the inactive role without exposing removed account details.
- When a Household Owner closes the Household, access is revoked immediately.
- The Household Chat and private media remain recoverable for 30 days, then are
  purged.
- Grocery Order, payment, security, or audit records that must follow a
  separate legal or provider retention policy are not erased through Chat
  deletion and are outside this ticket.

## Logical implementation records

The final backend may rename these records, but it must preserve their
separation:

- **Human message:** Household, sender membership, type, body/caption, private
  media reference, client-created time, server-created time, edited time, and
  deleted time.
- **Voice transcript:** message, detected language, transcript, generation
  status, and corrected transcript.
- **System event:** Household, event type, actor membership, structured entity
  type/id, safe rendering payload, and server-created time.
- **Private action suggestion:** author, Household, source message revision,
  intent type, proposed payload, status, and expiry.
- **Per-person Household state:** last-read position, global-default resolution,
  and Household notification override.
- **Device registration:** person, push token, platform, preview preference,
  last success, and invalidated time.

Human messages and system events may share one ordered presentation query, but
they must remain distinguishable so participant edits cannot mutate backend
events.

The logical Meal Plan transitions remain owned by
[issue 04](04-define-automatic-meal-planning.md), and quantity, matching, cart,
and request-fulfilment transitions remain owned by
[issue 05](05-define-estimated-pantry-and-cart.md). Those tickets may refine
entity state names, but must preserve the Chat permissions, confirmations,
attribution, and notification behavior resolved here.

## Acceptance criteria

1. An active participant can send text, one photo with an optional caption, or
   one voice note of at most two minutes.
2. An accepted Hindi or English text/voice message can produce a private action
   suggestion visible only to its author.
3. “I need grocery” asks for the missing item; it does not create a Grocery
   Request.
4. A Cook can confirm a Grocery Request, while a Household Member sees Add to
   Suggested Cart for equivalent intent.
5. No Chat action can place a Grocery Order or bypass Member review and fresh
   checkout confirmation.
6. A stale Meal Plan suggestion cannot overwrite a newer meal change without
   fresh confirmation.
7. A similar pending Grocery Request is shown before a Cook chooses to update
   it or keep a separate request.
8. Either active Cook can edit or cancel a pending request, the resulting event
   identifies the actor, and a concurrent conflicting mutation is rejected with
   the current state and actor shown for fresh confirmation rather than
   overwriting silently.
9. Bulk Meal Plan changes create one summary event and at most one push.
10. Grocery Request cards show current structured state while concise immutable
    events preserve meaningful transitions.
11. Human messages can be edited or deleted only by their author and only
    within 15 minutes; confirmed structured actions remain unchanged.
12. An offline message stays in its Household outbox, retries automatically,
    and cannot leak into another Household or create an action before server
    acceptance.
13. The default is role-aware — All activity for a Household Member and
    Important only for a Cook on a newly joined Household — and a person can set
    a default per membership role plus a per-Household All/Important/Muted
    override.
14. Important-only delivery produces the role-aware event sets in this
    contract; Muted produces no Household push but preserves in-app state.
15. Notification bursts collapse by Household, the actor receives no push for
    their own action, and a device viewing Chat receives no redundant push.
16. Full previews are enabled by default for coordination content; hiding
    previews on one device removes human and structured detail from that
    device's outbound payload, and payment/checkout/order amounts are always
    redacted from every preview regardless of setting.
17. Opening Chat clears eligible conversation unread through the visible
    position but does not clear pending structured action badges.
18. Routine system events neither add unread debt nor reorder the Cook's
    Household list.
19. Removed participants immediately lose Chat/media access and cannot send a
    queued message; prior history remains attributed.
20. Closing a Household revokes access immediately, supports recovery for 30
    days, and then purges Chat messages and media.
21. Human message text is never translated automatically; system events render
    in each viewer's selected English or Hindi locale.
22. Backend authorization tests prove that a message, event, media path,
    transcript, suggestion, or notification route cannot cross Household
    boundaries.
23. Correcting a voice transcript, or adding or editing a photo caption, within
    the edit window re-runs intent detection against the corrected text, and the
    suggestion remains private to the author until confirmed.
24. System event payloads and Chat history never contain payment amounts, order
    totals, or prices; a newly joined Cook can read prior Household history
    without exposure to Member-only financial detail.
