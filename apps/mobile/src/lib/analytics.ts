import PostHog from 'posthog-react-native';
import type { AnalyticsEventName, AnalyticsEventProperties } from './analytics-events';

const apiKey = process.env.EXPO_PUBLIC_POSTHOG_API_KEY?.trim();
const host = process.env.EXPO_PUBLIC_POSTHOG_HOST?.trim() || 'https://us.i.posthog.com';
const explicitlyDisabled = process.env.EXPO_PUBLIC_POSTHOG_DISABLED === 'true';
const designPreview = __DEV__ && process.env.EXPO_PUBLIC_COOKLINK_DESIGN_PREVIEW === 'true';

const posthog =
  apiKey && !explicitlyDisabled && !designPreview
    ? new PostHog(apiKey, {
        host,
        captureAppLifecycleEvents: true,
        disableGeoip: true,
        enableSessionReplay: false,
        before_send: (event) =>
          event
            ? {
                ...event,
                properties: { ...event.properties, is_test_event: __DEV__ },
              }
            : null,
        flushAt: 10,
        flushInterval: 10_000,
      })
    : null;

/** Explicit product events only; no touch autocapture, screen text, or household content. */
export function captureAnalyticsEvent<Event extends AnalyticsEventName>(
  event: Event,
  properties: AnalyticsEventProperties[Event],
): void {
  posthog?.capture(event, { ...properties, is_test_event: __DEV__ });
}

/** Associate activity with Cooklink's opaque auth identifier, never phone/name/email. */
export function identifyAnalyticsUser(userId: string): void {
  posthog?.identify(userId);
}

export function resetAnalyticsUser(): void {
  posthog?.reset();
}
