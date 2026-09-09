import assert from 'node:assert/strict';
import test from 'node:test';
import { parseServerConfig, validateServerConfig } from '../config.js';

/**
 * Server configuration matrix (issue 13). The startup gate must reject
 * inconsistent production configuration with actionable, secret-free
 * messages, while explicitly configured stub deployments with ordering
 * disabled remain fully supported.
 */

const VALID_KEY = Buffer.alloc(32, 7).toString('base64');

function baseEnv(): Record<string, string | undefined> {
  return {
    COOKLINK_SWIGGY_MODE: 'stub',
    COOKLINK_ORDERING_ENABLED: 'false',
    SWIGGY_TOKEN_ENCRYPTION_KEY: undefined,
  };
}

test('an explicitly configured stub deployment with ordering disabled is valid', () => {
  assert.deepEqual(validateServerConfig(baseEnv()), []);
  assert.deepEqual(validateServerConfig({}), []);
});

test('ordering=true with the stub provider is rejected (no silent live fallback)', () => {
  const env = baseEnv();
  env.COOKLINK_ORDERING_ENABLED = 'true';
  const problems = validateServerConfig(env);
  assert.equal(problems.length, 1);
  assert.match(problems[0]!, /COOKLINK_ORDERING_ENABLED=true is inconsistent/);
  assert.match(problems[0]!, /stub/);
});

test('a real provider mode requires a present, valid encryption key', () => {
  const env = baseEnv();
  env.COOKLINK_SWIGGY_MODE = 'production';
  env.SWIGGY_TOKEN_ENCRYPTION_KEY = undefined;
  let problems = validateServerConfig(env);
  assert.equal(problems.length, 1);
  assert.match(problems[0]!, /SWIGGY_TOKEN_ENCRYPTION_KEY is required/);

  // A malformed key is rejected too.
  env.SWIGGY_TOKEN_ENCRYPTION_KEY = 'not-a-valid-key';
  problems = validateServerConfig(env);
  assert.equal(problems.length, 1);
  assert.match(problems[0]!, /not a valid key/);

  // A valid key clears the problem for both staging and production.
  env.SWIGGY_TOKEN_ENCRYPTION_KEY = VALID_KEY;
  assert.deepEqual(validateServerConfig(env), []);
  env.COOKLINK_SWIGGY_MODE = 'staging';
  assert.deepEqual(validateServerConfig(env), []);
});

test('an unknown provider mode is rejected', () => {
  const env = baseEnv();
  env.COOKLINK_SWIGGY_MODE = 'live';
  const problems = validateServerConfig(env);
  // Two problems: the mode itself is invalid, and a non-stub mode requires
  // the (missing) encryption key. Both are actionable.
  assert.equal(problems.length, 2);
  assert.match(problems[0]!, /COOKLINK_SWIGGY_MODE is invalid/);
  assert.match(problems[1]!, /SWIGGY_TOKEN_ENCRYPTION_KEY is required/);
});

test('ordering=true with a real provider and a valid key is valid', () => {
  const env = baseEnv();
  env.COOKLINK_SWIGGY_MODE = 'production';
  env.COOKLINK_ORDERING_ENABLED = 'true';
  env.SWIGGY_TOKEN_ENCRYPTION_KEY = VALID_KEY;
  assert.deepEqual(validateServerConfig(env), []);
});

test('validation messages never echo variable values (secret-free errors)', () => {
  const env = baseEnv();
  env.COOKLINK_SWIGGY_MODE = 'production';
  env.SWIGGY_TOKEN_ENCRYPTION_KEY = 'super-secret-do-not-leak-value';
  const problems = validateServerConfig(env);
  assert.equal(problems.length, 1);
  assert.ok(!problems.some((p) => p.includes('super-secret-do-not-leak-value')));
});

// ---- production deployments must declare their provider transport ----

test('a production deployment without an explicit mode is rejected', () => {
  // NODE_ENV=production with the mode unset (or whitespace-only) must fail the
  // deploy instead of silently defaulting to the stub provider.
  for (const mode of [undefined, '', '   ']) {
    const env = baseEnv();
    env.NODE_ENV = 'production';
    if (mode === undefined) delete env.COOKLINK_SWIGGY_MODE;
    else env.COOKLINK_SWIGGY_MODE = mode;
    const problems = validateServerConfig(env);
    assert.equal(problems.length, 1);
    assert.match(problems[0]!, /COOKLINK_SWIGGY_MODE must be set explicitly in production/);
  }
});

test('an explicit stub with ordering disabled remains valid in production', () => {
  const env = baseEnv();
  env.NODE_ENV = 'production';
  env.COOKLINK_SWIGGY_MODE = 'stub';
  env.COOKLINK_ORDERING_ENABLED = 'false';
  assert.deepEqual(validateServerConfig(env), []);
  // Non-production environments keep the stub default when unset.
  assert.deepEqual(validateServerConfig({ NODE_ENV: 'development' }), []);
  assert.deepEqual(validateServerConfig({ NODE_ENV: undefined }), []);
});

test('a real provider mode is still required to be complete in production', () => {
  const env = baseEnv();
  env.NODE_ENV = 'production';
  env.COOKLINK_SWIGGY_MODE = 'production';
  // Two problems: the missing key, and nothing else (the explicit mode itself is valid).
  const problems = validateServerConfig(env);
  assert.equal(problems.length, 1);
  assert.match(problems[0]!, /SWIGGY_TOKEN_ENCRYPTION_KEY is required/);
  env.SWIGGY_TOKEN_ENCRYPTION_KEY = VALID_KEY;
  env.COOKLINK_ORDERING_ENABLED = 'true';
  assert.deepEqual(validateServerConfig(env), []);
});

// ---- boolean flags are validated, not silently coerced ----

test('a misspelled ordering flag value is rejected, not silently treated as false', () => {
  for (const value of ['True', 'TRUE', '1', 'yes', 'on', 'ture']) {
    const env = baseEnv();
    env.COOKLINK_ORDERING_ENABLED = value;
    const problems = validateServerConfig(env);
    assert.equal(problems.length, 1, `${value} must be rejected`);
    assert.match(problems[0]!, /COOKLINK_ORDERING_ENABLED must be exactly "true" or "false"/);
    assert.ok(!problems.some((p) => p.includes(value)), 'errors must not echo values');
  }
});

test('trimmed "true" / "false" and unset ordering flags are valid', () => {
  // "true" needs a real provider mode (with its key) to be consistent; the
  // point of the test is that the trimmed spelling itself is accepted.
  for (const value of ['true', ' true ']) {
    const env = baseEnv();
    env.COOKLINK_SWIGGY_MODE = 'production';
    env.SWIGGY_TOKEN_ENCRYPTION_KEY = VALID_KEY;
    env.COOKLINK_ORDERING_ENABLED = value;
    assert.deepEqual(validateServerConfig(env), []);
  }
  for (const value of [undefined, 'false', ' false ']) {
    const env = baseEnv();
    if (value === undefined) delete env.COOKLINK_ORDERING_ENABLED;
    else env.COOKLINK_ORDERING_ENABLED = value;
    assert.deepEqual(validateServerConfig(env), []);
  }
});

// ---- one parsed/normalized config: validation and startup cannot diverge ----

test('parseServerConfig returns the same normalized values validation checked', () => {
  // A whitespace-padded mode is accepted by validation — and the startup code
  // must run the same trimmed mode, not the raw untrimmed value.
  const env = baseEnv();
  env.COOKLINK_SWIGGY_MODE = '  production  ';
  env.COOKLINK_ORDERING_ENABLED = ' true ';
  env.SWIGGY_TOKEN_ENCRYPTION_KEY = VALID_KEY;
  assert.deepEqual(validateServerConfig(env), []);
  const parsed = parseServerConfig(env);
  assert.equal(parsed.swiggyMode, 'production');
  assert.equal(parsed.orderingEnabled, true);

  // Unset values normalize to the documented defaults.
  const defaults = parseServerConfig({});
  assert.equal(defaults.swiggyMode, 'stub');
  assert.equal(defaults.orderingEnabled, false);
});
