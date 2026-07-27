import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { grepMobileSecrets } from '../secrets-grep.js';

/**
 * CI grep test (issue 07, AC#7): no provider secret ships in the mobile
 * bundle or an EXPO_PUBLIC_* variable. This runs as part of the server test
 * suite so the gate is enforced locally and in CI without extra plumbing.
 */

test('the mobile bundle contains no provider secrets', () => {
  const violations = grepMobileSecrets();
  if (violations.length > 0) {
    console.error('Violations:', violations);
  }
  assert.equal(violations.length, 0, 'provider secret found in mobile bundle');
});

test('the scanner flags a planted provider-secret literal', () => {
  const root = mkdtempSync(join(tmpdir(), 'cooklink-secrets-'));
  try {
    writeFileSync(join(root, 'leak.ts'), 'export const db = process.env.DATABASE_URL;\n');
    const violations = grepMobileSecrets(root);
    assert.ok(violations.length >= 1, 'planted DATABASE_URL literal must be flagged');
    assert.ok(
      violations.some((v) => v.file === 'leak.ts' && /DATABASE_URL/i.test(v.pattern)),
      'violation points at the planted DATABASE_URL literal',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the scanner flags a forbidden EXPO_PUBLIC secret variable', () => {
  const root = mkdtempSync(join(tmpdir(), 'cooklink-secrets-'));
  try {
    writeFileSync(join(root, 'env.ts'), 'export const k = process.env.EXPO_PUBLIC_SWIGGY_TOKEN;\n');
    const violations = grepMobileSecrets(root);
    assert.ok(
      violations.some((v) => /EXPO_PUBLIC_SWIGGY_TOKEN/.test(v.pattern)),
      'forbidden EXPO_PUBLIC_SWIGGY_TOKEN variable must be flagged',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the publishable Clerk key is allowed, not flagged', () => {
  const root = mkdtempSync(join(tmpdir(), 'cooklink-secrets-'));
  try {
    writeFileSync(
      join(root, 'ok.ts'),
      'export const pk = process.env.EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY;\n',
    );
    const violations = grepMobileSecrets(root);
    assert.equal(
      violations.filter((v) => v.file === 'ok.ts').length,
      0,
      'publishable Clerk key must be allowed',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
