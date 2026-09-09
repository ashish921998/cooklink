import assert from 'node:assert/strict';
import test from 'node:test';
import appConfig from '../../app.config';
import {
  assertValidMobileBuildConfig,
  resolveBuildTarget,
  validateMobileProductionConfig,
} from '../lib/config';

/**
 * Production mobile configuration matrix (issue 13). Production builds must
 * reject a missing/invalid HTTPS API origin and a localhost API origin, plus
 * a missing Clerk publishable key — while development and preview builds keep
 * the supported localhost fallback and test-key behavior. The production
 * target is resolved from the EAS build environment (profile + bundled
 * marker), never from `__DEV__`, because internal preview release builds also
 * run with `__DEV__ === false`.
 */

const PROD = { isProductionBuild: true };

test('a production build rejects a missing API URL', () => {
  const problems = validateMobileProductionConfig({
    ...PROD,
    apiUrl: undefined,
    clerkPublishableKey: 'pk_test_placeholder',
  });
  assert.equal(problems.length, 1);
  assert.match(problems[0]!, /EXPO_PUBLIC_API_URL is missing/);
});

test('a production build rejects localhost and plain-HTTP API URLs', () => {
  for (const apiUrl of [
    'http://localhost:3000',
    'http://127.0.0.1:3000',
    'http://10.0.2.2:3000',
    'https://cooklink.local',
    'ftp://api.cooklink.app',
  ]) {
    const problems = validateMobileProductionConfig({
      ...PROD,
      apiUrl,
      clerkPublishableKey: 'pk_test_placeholder',
    });
    assert.ok(problems.length >= 1, `${apiUrl} must be rejected`);
    assert.match(problems[0]!, /EXPO_PUBLIC_API_URL/);
  }
});

test('a production build rejects a missing Clerk publishable key', () => {
  let problems = validateMobileProductionConfig({
    ...PROD,
    apiUrl: 'https://api.cooklink.app',
    clerkPublishableKey: undefined,
  });
  assert.equal(problems.length, 1);
  assert.match(problems[0]!, /EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY is missing/);

  problems = validateMobileProductionConfig({
    ...PROD,
    apiUrl: 'https://api.cooklink.app',
    clerkPublishableKey: '   ',
  });
  assert.equal(problems.length, 1);
});

test('a fully configured production build is valid', () => {
  const problems = validateMobileProductionConfig({
    ...PROD,
    apiUrl: 'https://api.cooklink.app',
    clerkPublishableKey: 'pk_test_placeholder',
  });
  assert.deepEqual(problems, []);
});

test('development and preview builds retain the localhost fallback behavior', () => {
  // No API URL, a localhost URL, and no Clerk key are all accepted in dev.
  assert.deepEqual(validateMobileProductionConfig({ isProductionBuild: false }), []);
  assert.deepEqual(
    validateMobileProductionConfig({
      isProductionBuild: false,
      apiUrl: 'http://localhost:3000',
      clerkPublishableKey: undefined,
    }),
    [],
  );
});

test('all problems are reported together and never echo values', () => {
  const problems = validateMobileProductionConfig({
    ...PROD,
    // Plain-HTTP and localhost are two distinct API-URL problems, plus the
    // missing publishable key — three actionable errors, no value echoes.
    apiUrl: 'http://localhost:3000',
    clerkPublishableKey: undefined,
  });
  assert.equal(problems.length, 3);
  for (const problem of problems) {
    assert.ok(!problem.includes('localhost:3000'), 'errors must not echo values');
  }
});

test('a production build rejects every loopback and local-only host spelling', () => {
  for (const apiUrl of [
    'https://[::1]', // IPv6 loopback (bracketed hostname)
    'http://[::1]:3000',
    'https://[::ffff:127.0.0.1]', // IPv4-mapped IPv6 loopback
    'https://0.0.0.0',
    'https://127.0.0.2', // loopback range beyond .1
    'https://api.localhost', // localhost subdomain
    'https://foo.bar.localhost',
    'https://shop.local',
  ]) {
    const problems = validateMobileProductionConfig({
      ...PROD,
      apiUrl,
      clerkPublishableKey: 'pk_test_placeholder',
    });
    assert.ok(
      problems.some((p) => /must not point at localhost or a local-only host/.test(p)),
      `${apiUrl} must be rejected as local-only`,
    );
  }
});

test('a production build rejects API URLs that are not a bare HTTPS origin', () => {
  for (const apiUrl of [
    'https://user:pass@api.cooklink.app', // credentials
    'https://api.cooklink.app?source=ci', // query string
    'https://api.cooklink.app/#/deep-link', // fragment
    'https://api.cooklink.app/v1/api', // unintended path
  ]) {
    const problems = validateMobileProductionConfig({
      ...PROD,
      apiUrl,
      clerkPublishableKey: 'pk_test_placeholder',
    });
    assert.ok(problems.length >= 1, `${apiUrl} must be rejected`);
    for (const problem of problems) {
      assert.ok(!problem.includes(apiUrl), 'errors must not echo values');
    }
  }
});

test('a production build accepts a bare HTTPS origin (with optional port or slash)', () => {
  for (const apiUrl of [
    'https://api.cooklink.app',
    'https://api.cooklink.app/',
    'https://api.cooklink.app:8443',
  ]) {
    assert.deepEqual(
      validateMobileProductionConfig({
        ...PROD,
        apiUrl,
        clerkPublishableKey: 'pk_test_placeholder',
      }),
      [],
      `${apiUrl} must be accepted`,
    );
  }
});

test('the production target comes from the EAS build environment, not __DEV__', () => {
  // Local expo start/export without EAS signals: development.
  assert.equal(resolveBuildTarget({}), 'development');
  // Built-in EAS Build profile signal.
  assert.equal(resolveBuildTarget({ EAS_BUILD_PROFILE: 'production' }), 'production');
  assert.equal(resolveBuildTarget({ EAS_BUILD_PROFILE: 'preview' }), 'preview');
  // Explicit bundled marker (EAS production environment / eas.json profile env).
  assert.equal(resolveBuildTarget({ EXPO_PUBLIC_COOKLINK_PRODUCTION_BUILD: 'true' }), 'production');
  assert.equal(resolveBuildTarget({ EXPO_PUBLIC_COOKLINK_PRODUCTION_BUILD: 'false' }), 'preview');
  // The explicit marker overrides the profile.
  assert.equal(
    resolveBuildTarget({
      EAS_BUILD_PROFILE: 'preview',
      EXPO_PUBLIC_COOKLINK_PRODUCTION_BUILD: 'true',
    }),
    'production',
  );
});

test('the build gate validates exactly the production target', () => {
  const prodEnv = { EAS_BUILD_PROFILE: 'production' };
  // Missing vars fail the production gate.
  assert.throws(() => assertValidMobileBuildConfig(prodEnv), /EXPO_PUBLIC_API_URL is missing/);
  assert.throws(
    () =>
      assertValidMobileBuildConfig({
        ...prodEnv,
        EXPO_PUBLIC_API_URL: 'http://localhost:3000',
        EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY: 'pk_test_placeholder',
      }),
    /must use HTTPS/,
  );
  // Valid vars pass it.
  assert.doesNotThrow(() =>
    assertValidMobileBuildConfig({
      ...prodEnv,
      EXPO_PUBLIC_API_URL: 'https://api.cooklink.app',
      EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY: 'pk_test_placeholder',
    }),
  );
  // Development and preview targets keep the localhost fallback and test keys.
  assert.doesNotThrow(() => assertValidMobileBuildConfig({}));
  assert.doesNotThrow(() =>
    assertValidMobileBuildConfig({
      EAS_BUILD_PROFILE: 'preview',
      EXPO_PUBLIC_API_URL: 'http://localhost:3000',
    }),
  );
});

test('the real build-config entrypoint (app.config.ts) fails fast on missing production vars', () => {
  const context = { config: {}, projectRoot: '/project', prebuild: false } as never;
  const saved = {
    profile: process.env.EAS_BUILD_PROFILE,
    marker: process.env.EXPO_PUBLIC_COOKLINK_PRODUCTION_BUILD,
    apiUrl: process.env.EXPO_PUBLIC_API_URL,
    key: process.env.EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY,
  };
  try {
    // A production EAS build with an empty environment is rejected before bundling.
    process.env.EAS_BUILD_PROFILE = 'production';
    process.env.EXPO_PUBLIC_COOKLINK_PRODUCTION_BUILD = 'true';
    delete process.env.EXPO_PUBLIC_API_URL;
    delete process.env.EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY;
    assert.throws(() => appConfig(context), /Invalid Cooklink production configuration/);

    // With the production environment populated, the build resolves unchanged.
    process.env.EXPO_PUBLIC_API_URL = 'https://api.cooklink.app';
    process.env.EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY = 'pk_test_placeholder';
    const resolved = appConfig(context);
    assert.equal(resolved.slug, 'cooklink');
    assert.equal(resolved.ios?.bundleIdentifier, 'com.cooklink.app');

    // A local run (no EAS signals at all) keeps dev fallbacks and skips the gate.
    delete process.env.EAS_BUILD_PROFILE;
    delete process.env.EXPO_PUBLIC_COOKLINK_PRODUCTION_BUILD;
    delete process.env.EXPO_PUBLIC_API_URL;
    delete process.env.EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY;
    assert.doesNotThrow(() => appConfig(context));
  } finally {
    if (saved.profile === undefined) delete process.env.EAS_BUILD_PROFILE;
    else process.env.EAS_BUILD_PROFILE = saved.profile;
    if (saved.marker === undefined) delete process.env.EXPO_PUBLIC_COOKLINK_PRODUCTION_BUILD;
    else process.env.EXPO_PUBLIC_COOKLINK_PRODUCTION_BUILD = saved.marker;
    if (saved.apiUrl === undefined) delete process.env.EXPO_PUBLIC_API_URL;
    else process.env.EXPO_PUBLIC_API_URL = saved.apiUrl;
    if (saved.key === undefined) delete process.env.EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY;
    else process.env.EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY = saved.key;
  }
});
