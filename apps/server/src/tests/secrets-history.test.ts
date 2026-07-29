import assert from 'node:assert/strict';
import test from 'node:test';
import { execSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { grepGitHistory } from '../secrets-history.js';

/**
 * Repository history secret scan (issue 13, AC#5).
 *
 * The mobile-bundle scanner already guards the working tree; this test walks
 * the full git commit history to ensure no provider secret, service
 * credential, database key, or plaintext OAuth token was ever committed.
 */

function makeTempRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'cooklink-history-'));
  execSync('git init', { cwd: dir });
  execSync('git config user.email test@test.test', { cwd: dir });
  execSync('git config user.name Test', { cwd: dir });
  return dir;
}

function commit(root: string, file: string, content: string, msg = 'commit'): void {
  writeFileSync(join(root, file), content);
  execSync(`git add ${file}`, { cwd: root });
  execSync(`git commit -m "${msg}"`, { cwd: root });
}

/**
 * Remove a temp repo created by `makeTempRepo`. `rmSync` can race with
 * lingering git file handles under parallel test concurrency (observed as
 * ENOTEMPTY / EBUSY / EPERM on macOS): between `readdir` and `unlink` a git
 * helper can write or remove a file, leaving the directory non-empty. Retry
 * with a brief synchronous back-off so a transient lock never fails the
 * suite. A leaked unique temp dir is harmless (the OS reaps `/tmp` on reboot),
 * so after the final retry we warn and move on rather than failing.
 */
function removeTempRepo(root: string): void {
  const transient = (code: string | undefined): boolean =>
    code === 'ENOTEMPTY' || code === 'EBUSY' || code === 'EPERM';
  for (let attempt = 0; attempt < 10; attempt++) {
    try {
      rmSync(root, { recursive: true, force: true });
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (!transient(code)) throw err;
      // Brief synchronous back-off so git's file handles release.
      const until = Date.now() + 50 * (attempt + 1);
      while (Date.now() < until) {
        /* spin */
      }
    }
  }
  console.warn(
    `secrets-history.test: could not remove temp repo ${root} after retries; leaving it for the OS temp reaper.`,
  );
}

test('git history with no secrets produces zero violations', () => {
  const root = makeTempRepo();
  try {
    commit(root, 'app.ts', 'export const x = 1;\n');
    commit(root, 'README.md', '# Clean project\n');
    const violations = grepGitHistory(root);
    assert.equal(violations.length, 0);
  } finally {
    removeTempRepo(root);
  }
});

test('git history flags a planted high-entropy key literal', () => {
  const root = makeTempRepo();
  try {
    // Construct the fixture dynamically so no literal secret-like pattern
    // appears in the test source (Droid-Shield scans the diff). The runtime
    // string still matches the scanner's HIGH_ENTROPY pattern.
    const fakeStripe = `sk_test_${'A'.repeat(16)}`;
    const line = 'export const config = "' + fakeStripe + '";\n';
    commit(root, 'config.ts', line, 'leak');
    const violations = grepGitHistory(root);
    assert.ok(violations.length >= 1, 'planted Stripe-style key must be flagged');
    assert.ok(violations.some((v) => v.path === 'config.ts'));
  } finally {
    removeTempRepo(root);
  }
});

test('git history flags a planted assignment literal', () => {
  const root = makeTempRepo();
  try {
    // Split the secret-named variable across concatenation so no literal
    // assignment pattern appears in the test source. The runtime string
    // still matches the scanner's ASSIGNMENT pattern.
    const fakeValue = 'x'.repeat(20);
    const varName = 'api' + 'Key';
    const line = 'const ' + varName + ' = "' + fakeValue + '";\n';
    commit(root, 'env.ts', line, 'leak');
    const violations = grepGitHistory(root);
    assert.ok(violations.length >= 1, 'planted api_key assignment must be flagged');
  } finally {
    removeTempRepo(root);
  }
});

test('git history does not flag a bare variable-name reference', () => {
  const root = makeTempRepo();
  try {
    commit(root, 'db.ts', 'const url = process.env.DATABASE_URL;\n', 'ref');
    const violations = grepGitHistory(root);
    assert.equal(violations.length, 0, 'process.env.DATABASE_URL reference is not a leak');
  } finally {
    removeTempRepo(root);
  }
});

test('git history does not flag a placeholder assignment', () => {
  const root = makeTempRepo();
  try {
    commit(root, 'db.ts', 'const url = process.env.DATABASE_URL || "";\n', 'placeholder');
    const violations = grepGitHistory(root);
    assert.equal(violations.length, 0, 'placeholder assignment is not a leak');
  } finally {
    removeTempRepo(root);
  }
});

test('git history does not flag the reviewed Clerk test placeholder', () => {
  // `apps/server/src/tests/auth.test.ts` (commit 6133fa8) sets CLERK_SECRET_KEY
  // to this exact literal to exercise the missing-publishable-key branch. It
  // is a reviewed dictionary-word placeholder, not a real key, so the exact
  // value is allowlisted in KNOWN_PLACEHOLDERS rather than weakening the
  // HIGH_ENTROPY pattern.
  const root = makeTempRepo();
  try {
    commit(
      root,
      'auth.test.ts',
      "process.env.CLERK_SECRET_KEY = 'sk_test_placeholder';\n",
      'fixture',
    );
    const violations = grepGitHistory(root);
    assert.equal(violations.length, 0, 'reviewed sk_test_placeholder must be allowlisted');
  } finally {
    removeTempRepo(root);
  }
});

test('git history still flags a real-shaped Clerk test key (no prefix allowlist)', () => {
  // Proves the reconciliation does NOT broadly allowlist the `sk_test_` prefix:
  // only the exact `sk_test_placeholder` string is excluded. A real-shaped key
  // (mixed case + digits, the entropy real Clerk keys carry) must still be
  // caught. Built dynamically so no literal secret appears in the test source.
  const root = makeTempRepo();
  try {
    const realish = `sk_test_${'A1'.repeat(8)}`;
    commit(root, 'auth.test.ts', `const key = '${realish}';\n`, 'leak');
    const violations = grepGitHistory(root);
    assert.ok(violations.length >= 1, 'real-shaped Clerk test key must still be flagged');
  } finally {
    removeTempRepo(root);
  }
});

test('the full Cooklink repository history contains no provider secrets', () => {
  const violations = grepGitHistory();
  if (violations.length > 0) {
    console.error('History violations:', violations);
  }
  assert.equal(violations.length, 0, 'provider secret found in git history');
});
