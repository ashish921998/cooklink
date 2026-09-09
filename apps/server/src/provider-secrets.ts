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
  'SWIGGY_TOKEN',
  'SWIGGY_SECRET',
  'SWIGGY_CLIENT_SECRET',
  'SWIGGY_CREDENTIAL',
  'SWIGGY_PASSWORD',
  'SWIGGY_ENCRYPTION',
  'ELEVENLABS_API_KEY',
  'ELEVEN_API_KEY',
  'OPENAI_API_KEY',
  'GEMINI_API_KEY',
  'GOOGLE_AI_KEY',
  'SENTRY_DSN',
] as const;

/** A single regex alternation matching any provider-secret name fragment. */
export const PROVIDER_SECRET_PATTERN = new RegExp(
  PROVIDER_SECRET_NAMES.map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'),
  'i',
);

/**
 * The mobile bundle may only expose the public Clerk publishable key, the
 * public PostHog ingestion settings, the API URL, and the `__DEV__`-only
 * local tooling flags. Every other `EXPO_PUBLIC_*` name is treated as a
 * secret leak (issue 07, AC#7).
 *
 * The `EXPO_PUBLIC_POSTHOG_*` names are not secrets: `EXPO_PUBLIC_POSTHOG_API_KEY`
 * holds PostHog's public project ingestion key (`phc_…`), which exists to be
 * embedded in clients — PostHog's private/personal API keys (`phx_…`) are a
 * different credential and stay forbidden. `EXPO_PUBLIC_POSTHOG_HOST` is an
 * ingestion URL and `EXPO_PUBLIC_POSTHOG_DISABLED` an opt-out flag (see
 * `apps/mobile/src/lib/analytics.ts`). The allowlist is exact-name, so any
 * other `POSTHOG` variable (e.g. a personal-key name) remains flagged.
 *
 * The `EXPO_PUBLIC_COOKLINK_DEV_*` names are not secrets: they carry a dev
 * user id, phone, and display name used solely to bypass Clerk OTP while the
 * app runs under `__DEV__` (see `apps/mobile/src/lib/api.ts`). They are inert
 * against a production server, which ignores the `x-cooklink-dev-*` headers
 * unless its own `COOKLINK_DEV_AUTH` env is `"true"` (see `auth.ts`).
 *
 * `EXPO_PUBLIC_COOKLINK_PRODUCTION_BUILD` is a boolean build marker (never a
 * credential): it declares a production EAS build so the bundled
 * configuration gate in `apps/mobile/src/lib/api.ts` keys on it instead of
 * `!__DEV__` (see `apps/mobile/app.config.ts`).
 */
export const ALLOWED_EXPO_PUBLIC = new Set([
  'EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY',
  'EXPO_PUBLIC_API_URL',
  'EXPO_PUBLIC_POSTHOG_API_KEY',
  'EXPO_PUBLIC_POSTHOG_HOST',
  'EXPO_PUBLIC_POSTHOG_DISABLED',
  'EXPO_PUBLIC_COOKLINK_DEV_AUTH',
  'EXPO_PUBLIC_COOKLINK_DEV_USER_ID',
  'EXPO_PUBLIC_COOKLINK_DEV_PHONE',
  'EXPO_PUBLIC_COOKLINK_DEV_NAME',
  'EXPO_PUBLIC_COOKLINK_DESIGN_PREVIEW',
  'EXPO_PUBLIC_COOKLINK_PRODUCTION_BUILD',
]);
