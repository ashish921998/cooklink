import type { ConfigContext, ExpoConfig } from 'expo/config';

/**
 * Production mobile configuration validation and the build-config entrypoint
 * (issue 13).
 *
 * A production mobile build must reject configuration that cannot talk to the
 * real backend: a missing or invalid HTTPS API origin, or a missing Clerk
 * publishable key. Development and preview builds keep the supported
 * behavior — `localhost:3000` fallbacks and test keys — so local iteration and
 * internal-distribution preview builds are unchanged.
 *
 * Production is detected from the build environment, not from `__DEV__`: an
 * internal preview release build also runs with `__DEV__ === false`, so keying
 * the gate on `!__DEV__` would wrongly gate preview builds. Two signals are
 * used, and either one is sufficient:
 *
 * - `EAS_BUILD_PROFILE=production`, a built-in EAS Build variable set for
 *   every cloud and local EAS build of the `production` profile;
 * - the explicit bundled marker `EXPO_PUBLIC_COOKLINK_PRODUCTION_BUILD=true`,
 *   set in the EAS `production` environment and in the eas.json `production`
 *   profile. Because it is `EXPO_PUBLIC_`-prefixed it is also inlined into the
 *   bundle, so the runtime fail-fast gate in `api.ts` can key on it.
 *
 * This module is the real build-config entrypoint evaluated by Expo/EAS for
 * every build, export, and local run. It must stay import-compatible with the
 * Expo config loader, which compiles only this entry file — the shared
 * validation logic therefore lives here, and `src/lib/config.ts` re-exports it
 * for the app bundle and tests. The pure functions keep the config matrix
 * unit-testable. Messages name the variable, the problem, and the fix, and
 * never echo variable values.
 */

/** The explicit bundled production marker (see module docs). */
export const PRODUCTION_BUILD_MARKER = 'EXPO_PUBLIC_COOKLINK_PRODUCTION_BUILD';

/** The build target a given build environment resolves to. */
export type MobileBuildTarget = 'production' | 'preview' | 'development';

/**
 * Resolve the build target from the build environment. Local `expo start` /
 * `expo export` without EAS signals resolves to `development`, which keeps the
 * documented dev/preview fallbacks and skips the production gate entirely.
 */
export function resolveBuildTarget(env: Record<string, string | undefined>): MobileBuildTarget {
  if (env[PRODUCTION_BUILD_MARKER] === 'true' || env.EAS_BUILD_PROFILE === 'production') {
    return 'production';
  }
  if (env[PRODUCTION_BUILD_MARKER] === 'false' || env.EAS_BUILD_PROFILE === 'preview') {
    return 'preview';
  }
  return 'development';
}

export interface MobileConfigInput {
  /** Raw `EXPO_PUBLIC_API_URL` value (undefined when unset). */
  apiUrl?: string | null;
  /** Raw `EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY` value (undefined when unset). */
  clerkPublishableKey?: string | null;
  /** True only when the build target is production (see module docs). */
  isProductionBuild: boolean;
}

export function validateMobileProductionConfig(input: MobileConfigInput): string[] {
  // Development and preview builds retain the supported local behavior:
  // the localhost fallback and test keys are intentional there.
  if (!input.isProductionBuild) return [];

  const problems: string[] = [];

  const rawApiUrl = input.apiUrl?.trim();
  if (!rawApiUrl) {
    problems.push(
      'EXPO_PUBLIC_API_URL is missing. Set it to the public HTTPS Cooklink API origin ' +
        '(for example https://api.cooklink.app) in the production EAS environment.',
    );
  } else {
    let url: URL | null = null;
    try {
      url = new URL(rawApiUrl);
    } catch {
      problems.push(
        'EXPO_PUBLIC_API_URL is not a valid absolute URL. Set it to the public HTTPS ' +
          'Cooklink API origin (for example https://api.cooklink.app).',
      );
    }
    if (url) problems.push(...apiOriginProblems(url));
  }

  if (!input.clerkPublishableKey?.trim()) {
    problems.push(
      'EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY is missing. Set it to the Clerk publishable key ' +
        'in the production EAS environment.',
    );
  }

  return problems;
}

/**
 * An API URL must be a bare HTTPS origin: the API client appends request
 * paths itself, so a URL that carries credentials, a query, a fragment, or a
 * path would silently produce requests to somewhere else than intended.
 * Loopback and local-only hosts are rejected in every spelling (IPv4 and
 * IPv6 loopback ranges, localhost subdomains, `.local`, and the Android
 * emulator's host alias).
 */
function apiOriginProblems(url: URL): string[] {
  const problems: string[] = [];

  if (url.protocol !== 'https:') {
    problems.push(
      'EXPO_PUBLIC_API_URL must use HTTPS in production builds. Plain HTTP is only ' +
        'supported in development. Set it to the public HTTPS Cooklink API origin.',
    );
  }

  // `URL.hostname` keeps IPv6 brackets (`[::1]`); normalize for comparison.
  const host = url.hostname.toLowerCase();
  const bareHost = host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
  const isLoopbackV4 = /^127\./.test(bareHost) || bareHost === '0.0.0.0';
  // IPv6 loopback plus its IPv4-mapped spellings (`::ffff:127.0.0.1`
  // serializes as `::ffff:7f00:1`).
  const isLoopbackV6 = bareHost === '::1' || /^::ffff:7f/i.test(bareHost);
  const isLocalName =
    bareHost === 'localhost' ||
    bareHost.endsWith('.localhost') ||
    bareHost.endsWith('.local') ||
    bareHost === '10.0.2.2';
  if (isLoopbackV4 || isLoopbackV6 || isLocalName) {
    problems.push(
      'EXPO_PUBLIC_API_URL must not point at localhost or a local-only host in ' +
        'production builds. Set it to the public HTTPS Cooklink API origin.',
    );
  }
  if (url.username !== '' || url.password !== '') {
    problems.push(
      'EXPO_PUBLIC_API_URL must not embed credentials (user:password@host). ' +
        'Set it to the bare public HTTPS Cooklink API origin.',
    );
  }
  if (url.search !== '' || url.hash !== '') {
    problems.push(
      'EXPO_PUBLIC_API_URL must be a bare origin without a query string or fragment. ' +
        'Set it to the public HTTPS Cooklink API origin.',
    );
  }
  if (url.pathname !== '' && url.pathname !== '/') {
    problems.push(
      'EXPO_PUBLIC_API_URL must be an origin only, without a path — the API client ' +
        'appends the request path itself. Set it to the public HTTPS Cooklink API origin.',
    );
  }

  return problems;
}

/**
 * The build-time gate: invoked below for every Expo/EAS config evaluation, so
 * a misconfigured production build fails before any JavaScript is bundled.
 * Development and preview targets skip validation entirely.
 */
export function assertValidMobileBuildConfig(env: Record<string, string | undefined>): void {
  if (resolveBuildTarget(env) !== 'production') return;
  const problems = validateMobileProductionConfig({
    apiUrl: env.EXPO_PUBLIC_API_URL,
    clerkPublishableKey: env.EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY,
    isProductionBuild: true,
  });
  if (problems.length > 0) {
    throw new Error(`Invalid Cooklink production configuration:\n- ${problems.join('\n- ')}`);
  }
}

/**
 * The runtime fail-fast gate for the bundled app: throws an actionable,
 * secret-free error listing every configuration problem. Invoked at module
 * load of the API client, keyed on the bundled production marker (see module
 * docs) — a pure belt-and-braces second layer behind the build-time gate.
 */
export function assertValidMobileProductionConfig(input: MobileConfigInput) {
  const problems = validateMobileProductionConfig(input);
  if (problems.length > 0) {
    throw new Error(`Invalid Cooklink production configuration:\n- ${problems.join('\n- ')}`);
  }
}

/**
 * The Expo/EAS build-config entrypoint (the former app.json). The gate above
 * runs on every evaluation, production builds included.
 */
export default (_context: ConfigContext): ExpoConfig => {
  assertValidMobileBuildConfig(process.env);
  return {
    name: 'Cooklink',
    owner: 'ashish921998',
    slug: 'cooklink',
    scheme: 'cooklink',
    version: '1.0.0',
    orientation: 'portrait',
    userInterfaceStyle: 'light',
    icon: './assets/icon.png',
    ios: {
      supportsTablet: false,
      bundleIdentifier: 'com.cooklink.app',
      buildNumber: '1',
      infoPlist: {
        ITSAppUsesNonExemptEncryption: false,
      },
    },
    android: {
      package: 'com.cooklink.app',
      versionCode: 1,
      adaptiveIcon: {
        foregroundImage: './assets/adaptive-icon.png',
        monochromeImage: './assets/monochrome-icon.png',
        backgroundColor: '#f7f3ed',
      },
      permissions: [
        'android.permission.RECORD_AUDIO',
        'android.permission.MODIFY_AUDIO_SETTINGS',
        'android.permission.FOREGROUND_SERVICE',
        'android.permission.FOREGROUND_SERVICE_MEDIA_PLAYBACK',
      ],
    },
    web: {
      favicon: './assets/favicon.png',
    },
    plugins: [
      'expo-router',
      'expo-secure-store',
      [
        'expo-audio',
        {
          microphonePermission:
            'Allow Cooklink to record voice notes you choose to share with your household.',
        },
      ],
      [
        'expo-image-picker',
        {
          photosPermission:
            'Allow Cooklink to choose photos you want to share with your household.',
        },
      ],
      [
        'expo-splash-screen',
        {
          image: './assets/splash-icon.png',
          resizeMode: 'contain',
          backgroundColor: '#f7f3ed',
        },
      ],
      'expo-web-browser',
      'expo-status-bar',
      '@clerk/expo',
      'expo-asset',
      'expo-localization',
    ],
    extra: {
      router: {},
      eas: {
        projectId: '72cd23d6-40d5-4fb4-84b8-98adb8ebc652',
      },
    },
  };
};
