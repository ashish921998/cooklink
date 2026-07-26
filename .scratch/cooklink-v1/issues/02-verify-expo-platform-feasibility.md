# Verify the minimal Expo platform foundation

Type: research
Status: resolved
Blocked by:

## Question

Using current primary documentation, which Expo-compatible capabilities and constraints matter for a single iOS/Android app that supports role-aware authentication, secure Swiggy OAuth handoff, real-time household chat, photo and voice-note media, push notifications, Hindi/English localization, and on-demand ElevenLabs recipe speech?

## Answer

The required V1 capabilities are supported by one Expo app, provided Cooklink uses development builds and an authenticated server boundary for secrets and privileged integrations. Household roles must be enforced as per-household memberships server-side; chat/media must be private and household-scoped; Expo supports foreground photo/voice-note capture, push, and English/Hindi localization; and ElevenLabs TTS should be generated on demand and cached through the backend. Detailed findings, citations, constraints, and remaining implementation decisions are in [Minimal Expo platform foundation](../research/expo-platform-foundation.md).
