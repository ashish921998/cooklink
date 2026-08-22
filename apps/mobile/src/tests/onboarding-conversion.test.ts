import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const appSource = readFileSync(join(__dirname, '..', '..', 'app', 'index.tsx'), 'utf8');
const inviteRouteSource = readFileSync(join(__dirname, '..', '..', 'app', 'invite.tsx'), 'utf8');
const acceptInviteSource = readFileSync(
  join(__dirname, '..', 'screens', 'AcceptInvite.tsx'),
  'utf8',
);
const householdsSource = readFileSync(join(__dirname, '..', 'lib', 'households.ts'), 'utf8');

test('conversion onboarding starts with an explicit role choice', () => {
  assert.ok(appSource.includes("designPreview === 'onboarding'"));
  assert.ok(appSource.includes('testID="role-first-screen"'));
  assert.ok(appSource.includes('Step 1 of 2 · Choose your role'));
  assert.ok(appSource.includes('Household owner'));
  assert.ok(appSource.includes('Household member'));
  assert.ok(appSource.includes('Hired cook'));
});

test('member and cook choices preserve role context through the invite route', () => {
  assert.ok(appSource.includes('/invite?expected_role=${expectedRole}'));
  assert.ok(inviteRouteSource.includes('expected_role'));
  assert.ok(inviteRouteSource.includes('expectedRole={expectedRole}'));
  assert.ok(acceptInviteSource.includes('Join a work household'));
  assert.ok(acceptInviteSource.includes('Join your household'));
});

test('owner setup leads with a measurable plan outcome and optional defaults', () => {
  assert.ok(appSource.includes('testID="owner-onboarding-screen"'));
  assert.ok(appSource.includes('Your first week, ready in about 15 seconds'));
  assert.ok(appSource.includes('Household name (required)'));
  assert.ok(appSource.includes('Starter choices'));
  assert.ok(appSource.includes('Personalize first (optional)'));
  assert.ok(appSource.includes('Create my 7-day plan'));
  assert.ok(appSource.includes('testID="onboarding-complete-screen"'));
  assert.ok(appSource.includes('21 meals are active'));
});

test('owner setup communicates validation and disclosure state accessibly', () => {
  assert.ok(appSource.includes('COLLAPSED_ACCESSIBILITY_STATE'));
  assert.ok(appSource.includes('EXPANDED_ACCESSIBILITY_STATE'));
  assert.ok(appSource.includes('DISABLED_ACCESSIBILITY_STATE'));
  assert.ok(appSource.includes('disabled={!canCreate}'));
});

test('production onboarding contains no internal prototype warning', () => {
  assert.equal(appSource.includes('SPEC GAP SURFACED'), false);
});

test('successful household reload clears profile-required onboarding errors', () => {
  const loadHouseholds = householdsSource.slice(
    householdsSource.indexOf('const loadHouseholds'),
    householdsSource.indexOf('// On first load'),
  );
  assert.ok(loadHouseholds.includes('setError(null)'));
  assert.ok(loadHouseholds.indexOf('setError(null)') < loadHouseholds.indexOf('setHouseholds'));
});
