import { decodeSecretKey } from './secret-box.js';

/**
 * Production server configuration validation (issue 13).
 *
 * An intended live deployment must fail fast, loudly, and without leaking
 * secrets when its configuration is inconsistent — most importantly, it must
 * never silently run real ordering against the stub provider. Explicitly
 * configured stub deployments with ordering disabled remain fully supported
 * (local development, preview environments).
 *
 * `validateServerConfig` and `parseServerConfig` are pure functions over an
 * env-like record so the config matrix is unit-testable, and so the startup
 * code in `index.ts` consumes exactly the same parsed/normalized values that
 * were validated — there is no second, untrimmed read of the raw environment
 * that could diverge from what was checked. `assertValidServerConfig` is the
 * startup gate. Messages name the variable, the problem, and the fix. They
 * never echo variable values, so they cannot leak credentials into logs or
 * error traces.
 */

const VALID_SWIGGY_MODES = ['stub', 'staging', 'production'] as const;

export type SwiggyMode = (typeof VALID_SWIGGY_MODES)[number];

/** The provider mode and feature flag a deployment will actually run with. */
export interface ServerConfig {
  /** Normalized (trimmed) provider mode; defaults to `stub`. */
  swiggyMode: SwiggyMode;
  /** Normalized `COOKLINK_ORDERING_ENABLED` (strictly `true`/`false`). */
  orderingEnabled: boolean;
}

/**
 * Parse and normalize the provider configuration. Runs on the same trimmed
 * values the validator checked; call `assertValidServerConfig` first so an
 * invalid mode can never reach a deployment's runtime behavior.
 */
export function parseServerConfig(env: Record<string, string | undefined>): ServerConfig {
  const rawMode = env.COOKLINK_SWIGGY_MODE?.trim();
  const swiggyMode = (VALID_SWIGGY_MODES as readonly string[]).includes(rawMode ?? 'stub')
    ? ((rawMode || 'stub') as SwiggyMode)
    : 'stub';
  return {
    swiggyMode,
    orderingEnabled: env.COOKLINK_ORDERING_ENABLED?.trim() === 'true',
  };
}

export function validateServerConfig(env: Record<string, string | undefined>): string[] {
  const problems: string[] = [];

  const rawMode = env.COOKLINK_SWIGGY_MODE?.trim();
  const mode = rawMode || 'stub';
  if (env.NODE_ENV === 'production' && !rawMode) {
    // An intended live deployment must declare its provider transport; the
    // stub default is for development and preview environments only.
    problems.push(
      'COOKLINK_SWIGGY_MODE must be set explicitly in production deployments ' +
        '(NODE_ENV=production). It must be one of: stub, staging, production.',
    );
  }
  if (!(VALID_SWIGGY_MODES as readonly string[]).includes(mode)) {
    problems.push(
      'COOKLINK_SWIGGY_MODE is invalid. It must be one of: stub, staging, production. ' +
        'Set it to the intended provider transport and redeploy.',
    );
  }

  // Strict boolean: a typo like "True" or "1" must fail the deploy instead of
  // being silently treated as "false" (which would disable ordering).
  const rawOrdering = env.COOKLINK_ORDERING_ENABLED?.trim();
  if (
    rawOrdering !== undefined &&
    rawOrdering !== '' &&
    rawOrdering !== 'true' &&
    rawOrdering !== 'false'
  ) {
    problems.push(
      'COOKLINK_ORDERING_ENABLED must be exactly "true" or "false" (or unset). ' +
        'Any other value is treated as a typo and rejected.',
    );
  }
  const orderingEnabled = rawOrdering === 'true';
  if (orderingEnabled && mode === 'stub') {
    problems.push(
      'COOKLINK_ORDERING_ENABLED=true is inconsistent with COOKLINK_SWIGGY_MODE=stub. ' +
        'The stub provider cannot place real orders, and an intended live deployment must not ' +
        'silently fall back to the stub. Set COOKLINK_SWIGGY_MODE to "staging" or "production", ' +
        'or set COOKLINK_ORDERING_ENABLED=false to keep an explicitly stub deployment with ' +
        'ordering disabled.',
    );
  }

  if (mode !== 'stub') {
    const key = env.SWIGGY_TOKEN_ENCRYPTION_KEY?.trim();
    if (!key) {
      problems.push(
        'SWIGGY_TOKEN_ENCRYPTION_KEY is required when COOKLINK_SWIGGY_MODE is not stub. ' +
          'Generate one with: openssl rand -base64 32',
      );
    } else {
      try {
        decodeSecretKey(key);
      } catch {
        problems.push(
          'SWIGGY_TOKEN_ENCRYPTION_KEY is not a valid key. It must decode from base64 to ' +
            'exactly 32 bytes. Generate one with: openssl rand -base64 32',
        );
      }
    }
  }

  return problems;
}

/**
 * The startup gate: throws an actionable, secret-free error listing every
 * configuration problem. Called before the server binds a port so a bad
 * deployment fails its health checks instead of serving inconsistent state.
 */
export function assertValidServerConfig(env: Record<string, string | undefined> = process.env) {
  const problems = validateServerConfig(env);
  if (problems.length > 0) {
    throw new Error(`Invalid Cooklink server configuration:\n- ${problems.join('\n- ')}`);
  }
}
