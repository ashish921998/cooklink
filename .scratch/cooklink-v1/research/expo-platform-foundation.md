# Minimal Expo platform foundation

Research date: 2026-07-25

## Finding

A single Expo/React Native application is a credible V1 foundation for both Household Members and Cooks. The required device capabilities exist in current Expo SDKs; the integration is not an Expo-Go-only project because OAuth callbacks and remote push notifications require a development build and configured native app scheme/credentials.

The smallest responsible architecture is:

- one Expo app with role-aware navigation;
- one authenticated backend with household membership and authorization enforced in the database/API;
- private object storage for chat photos, voice notes, and optionally generated recipe audio;
- realtime household-scoped message delivery;
- server functions as the only boundary allowed to hold Swiggy and ElevenLabs credentials or perform privileged operations.

Supabase is a viable consolidated backend candidate because its official Expo/React Native guidance covers client sessions, while its first-party platform provides Postgres/RLS, Realtime, Storage, and server-side Edge Functions. This establishes feasibility, not a mandatory stack choice.

## Decisions the implementation spec should lock

### 1. App identity and role-aware authentication

Use one user identity per person and model roles through household membership records, not separate Member and Cook apps or a single global `role` flag. A Cook may belong to as many as 30 households and a Member may also belong to more than one; authorization therefore needs the tuple `(user, household, role)` with roles such as `owner`, `member`, and `cook`.

An Expo-compatible auth provider can persist a mobile session, but the implementation must enforce access server-side with household-scoped database policies. Supabase's official Expo and React Native quickstarts confirm `supabase-js` support in an Expo app; its RLS guidance and Realtime documentation provide the necessary server-side policy boundary. Client-side role checks are navigation/UX only, never authorization.

Sources:

- [Expo authentication guide](https://docs.expo.dev/develop/authentication/)
- [Supabase Expo React Native quickstart](https://supabase.com/docs/guides/getting-started/quickstarts/expo-react-native)
- [Supabase Row Level Security](https://supabase.com/docs/guides/database/postgres/row-level-security)

Open implementation decision: choose the V1 sign-in method (for example phone OTP versus another passwordless option) only after checking provider availability, delivery reliability, and India pricing. That choice is not required to establish Expo feasibility.

### 2. OAuth callback and secure Swiggy boundary

`expo-auth-session` supports OAuth/OIDC browser flows and native redirect URIs on iOS and Android. The app needs a stable custom URL scheme and a development build; Expo explicitly states that Expo Go cannot test OAuth/OIDC flows that require a customized scheme. `AuthSession.makeRedirectUri()` should construct the callback, and the registered callback must match the production app identity.

The mobile bundle is not a secure place for client secrets. Expo's official authentication guidance says authorization-code exchange involving a client secret must occur on a server. Therefore:

- the app launches and receives the browser authorization result;
- the backend validates the authenticated Cooklink user and household context;
- the backend performs any secret-bearing code exchange and stores provider tokens encrypted/server-side;
- only the backend invokes Swiggy MCP tools;
- every checkout still requires an explicit, fresh Member confirmation and server-side household-role check.

Use PKCE/state where the provider supports them, but do not claim Swiggy's exact grant, scopes, token lifetime, or refresh behavior until the dedicated Swiggy research ticket confirms those details.

Sources:

- [Expo OAuth/OIDC authentication guide](https://docs.expo.dev/guides/authentication/)
- [Expo AuthSession reference](https://docs.expo.dev/versions/latest/sdk/auth-session/)
- [Supabase Edge Functions](https://supabase.com/docs/guides/functions)
- [Supabase Edge Function secrets](https://supabase.com/docs/guides/functions/secrets)

### 3. Household chat

For V1, persist messages first and subscribe to household-scoped changes. This gives durable history, reconnect behavior, unread calculations, and system messages for meal edits and Grocery Requests without building a separate chat service.

Supabase Realtime can subscribe to Postgres changes and apply RLS authorization. Its documentation notes that Postgres Changes performs authorization per subscriber and processes changes on one thread; that is acceptable for small household rooms and a V1, but should be load-tested before a large rollout. Keep the V1 schema simple: one conversation per household, ordered messages, sender, message type (`text`, `photo`, `voice`, `system`), optional media reference, and created timestamp. Do not add presence, typing indicators, reactions, read receipts, or DMs.

Source: [Supabase Realtime Postgres Changes](https://supabase.com/docs/guides/realtime/postgres-changes)

### 4. Photos and voice notes

`expo-image-picker` can take a photo or select one from the system library on Android and iOS. `expo-audio` can record and play audio and returns a local recording URI. V1 voice notes only need foreground recording, so background-recording permissions and services should remain disabled.

After capture, upload the file to private object storage and persist only its storage path plus basic metadata on the message. Serve it through an authenticated request or short-lived signed URL; do not make household media public. Compress/resize large photos before upload, cap voice-note duration and file size, and show explicit retry state because uploads can fail independently of message creation.

Expo's ImagePicker documentation also notes Android may kill the activity after selection; the app should recover the result with `getPendingResultAsync`.

Sources:

- [Expo ImagePicker](https://docs.expo.dev/versions/latest/sdk/imagepicker/)
- [Expo Audio](https://docs.expo.dev/versions/latest/sdk/audio/)
- [Supabase Storage](https://supabase.com/docs/guides/storage)

Open implementation decision: set practical V1 upload limits and retention after observing expected use; the platform does not dictate the product limits.

### 5. Push notifications

`expo-notifications` supports Expo push tokens as well as native APNs/FCM tokens, receipt/response listeners, and Android notification channels. Remote push notifications require a development build on Android and platform credentials; they are not fully testable in Expo Go.

For V1, store push tokens per user-device and send notifications from the backend for:

- new non-muted household chat messages;
- Cook meal changes;
- new Grocery Requests and their approval/order status.

Notification payloads should contain only a route and opaque record identifiers, not sensitive chat or grocery detail on the lock screen. The client must re-authorize and fetch current data when a notification is opened. Token registration needs retry and stale-token cleanup.

Sources:

- [Expo Notifications](https://docs.expo.dev/versions/latest/sdk/notifications/)
- [Expo push notifications overview](https://docs.expo.dev/push-notifications/overview/)

### 6. English and Hindi

`expo-localization` exposes device locale information and works with standard JavaScript localization libraries. Cooklink should store the Cook's explicit app-language choice (`en` or `hi`) in their profile, default to English when skipped, and allow later changes; device locale may seed the choice but should not override it.

Keep all interface and system-message strings in translation resources. Store meal/recipe content with an explicit language code or generate localized variants server-side. English and Hindi are both left-to-right, so V1 does not need RTL layout work.

Sources:

- [Expo localization guide](https://docs.expo.dev/guides/localization/)
- [Expo Localization API](https://docs.expo.dev/versions/latest/sdk/localization/)

### 7. On-demand ElevenLabs recipe speech

ElevenLabs exposes an HTTP streaming TTS endpoint that returns generated audio bytes and supports multilingual models. That is sufficient for a Play button on a complete English or Hindi recipe. WebSocket streaming is unnecessary because the entire recipe text already exists before playback.

Call ElevenLabs from the backend so its API key never ships in the Expo bundle. Send the selected recipe-language text, return or store an MP3, and play it with `expo-audio`. Cache by a content key such as recipe version, language, voice, model, and speaking settings so repeated plays do not repeatedly incur generation cost. Generate only on demand, expose retry/text fallback, and keep recipe steps short enough for understandable playback.

Before production, explicitly validate the chosen voice/model's Hindi pronunciation on representative Bengaluru household recipes and verify ElevenLabs plan/commercial terms and data-retention settings. Platform support does not guarantee acceptable pronunciation.

Sources:

- [ElevenLabs streaming TTS endpoint](https://elevenlabs.io/docs/api-reference/text-to-speech/stream)
- [ElevenLabs Text to Speech overview](https://elevenlabs.io/docs/overview/capabilities/text-to-speech)
- [ElevenLabs streaming concepts](https://elevenlabs.io/docs/eleven-api/concepts/audio-streaming)
- [Expo Audio](https://docs.expo.dev/versions/latest/sdk/audio/)

## V1 constraints and validation gates

- Use Expo development builds from the start; OAuth callbacks and remote push are release-critical native integrations.
- Treat all household data as private and enforce household membership with backend/database policies.
- Never put Swiggy, ElevenLabs, backend secret/service-role keys, or OAuth client secrets in `EXPO_PUBLIC_*` variables or the mobile bundle.
- Keep Swiggy ordering and TTS in short-lived authenticated server functions; add idempotency around checkout and generated assets.
- Test callback restoration, notification deep links, microphone/camera denial, interrupted uploads, offline/reconnect chat, Hindi rendering, and Hindi TTS on physical iOS and Android devices.
- Defer background audio recording, complex chat presence, a separate admin surface, and a bespoke realtime/media stack.

## Resolution

No platform blocker was found for the requested V1. The remaining work is to lock a minimal backend/auth provider and exact schemas/policies, then prototype the highest-risk seams: native OAuth callback restoration, private media upload, notification delivery, and Hindi TTS quality.
