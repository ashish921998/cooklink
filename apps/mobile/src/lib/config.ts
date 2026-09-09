/**
 * App-side surface of the production configuration validation.
 *
 * The authoritative module is `app.config.ts` (the real build-config
 * entrypoint evaluated by Expo/EAS): the Expo config loader compiles only the
 * entry file, so the shared logic lives there and this module re-exports it
 * for the Metro bundle (`api.ts` and friends) and the tests.
 */
export {
  PRODUCTION_BUILD_MARKER,
  assertValidMobileBuildConfig,
  assertValidMobileProductionConfig,
  resolveBuildTarget,
  validateMobileProductionConfig,
} from '../../app.config';
export type { MobileBuildTarget, MobileConfigInput } from '../../app.config';
