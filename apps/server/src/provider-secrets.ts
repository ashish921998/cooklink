/**
 * The set of provider-secret name fragments that must never appear in the
 * mobile bundle or in any `EXPO_PUBLIC_*` variable (issue 07, AC#7). Both the
 * runtime env check (`secrets-check.ts`) and the mobile-source grep
 * (`secrets-grep.ts`) share this single list so adding a provider is a
 * one-place edit.
 */
export const PROVIDER_SECRET_NAMES = [
  'CLERK_SECRET',
  'DATABASE_URL',
  'SWIGGY',
  'ELEVEN',
  'ELEVENLABS',
  'OPENAI',
  'GEMINI',
  'GOOGLE_AI_KEY',
  'SENTRY_DSN',
] as const;

/** A single regex alternation matching any provider-secret name fragment. */
export const PROVIDER_SECRET_PATTERN = new RegExp(
  PROVIDER_SECRET_NAMES.map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'),
  'i',
);

/**
 * The mobile bundle may only expose the public Clerk publishable key, the API
 * URL, and the `__DEV__`-only dev-auth fixtures. Every other `EXPO_PUBLIC_*`
 * name is treated as a secret leak (issue 07, AC#7).
 *
 * The `EXPO_PUBLIC_COOKLINK_DEV_*` names are not secrets: they carry a dev
 * user id, phone, and display name used solely to bypass Clerk OTP while the
 * app runs under `__DEV__` (see `apps/mobile/src/lib/api.ts`). They are inert
 * against a production server, which ignores the `x-cooklink-dev-*` headers
 * unless its own `COOKLINK_DEV_AUTH` env is `"true"` (see `auth.ts`).
 */
export const ALLOWED_EXPO_PUBLIC = new Set([
  'EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY',
  'EXPO_PUBLIC_API_URL',
  'EXPO_PUBLIC_COOKLINK_DEV_AUTH',
  'EXPO_PUBLIC_COOKLINK_DEV_USER_ID',
  'EXPO_PUBLIC_COOKLINK_DEV_PHONE',
  'EXPO_PUBLIC_COOKLINK_DEV_NAME',
]);
