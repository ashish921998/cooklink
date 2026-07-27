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
 * The mobile bundle may only expose the public Clerk publishable key and the
 * API URL. Every other `EXPO_PUBLIC_*` name is treated as a secret leak
 * (issue 07, AC#7).
 */
export const ALLOWED_EXPO_PUBLIC = new Set([
  'EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY',
  'EXPO_PUBLIC_API_URL',
]);
