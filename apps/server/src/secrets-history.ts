import { execSync } from 'node:child_process';
import { PROVIDER_SECRET_PATTERN } from './provider-secrets.js';

/**
 * Repository history secret scan (issue 13, AC#5).
 *
 * The mobile-bundle scanner (`secrets-grep.ts`) guards the working tree. This
 * module walks the full git commit history (blob text of every tracked file
 * across every commit) and fails if a provider secret, service credential,
 * database key, or plaintext token literal has ever been committed.
 *
 * It runs as part of the release-gate test suite so a historical leak is
 * caught before the handoff.
 */

export interface HistoryViolation {
  commit: string;
  path: string;
  line: number;
  pattern: string;
  text: string;
}

/** High-entropy literals that look like real provider credentials. */
const HIGH_ENTROPY =
  /\b(sk_(test|live)_[A-Za-z0-9]{10,}|AIza[A-Za-z0-9_-]{30,}|sk-[A-Za-z0-9]{20,}|sk-ant-[A-Za-z0-9_-]{30,})\b/;

/** Assignment of a concrete value to a secret-named variable. */
const ASSIGNMENT =
  /\b(secret|password|api[_-]?key|access[_-]?token|refresh[_-]?token|private[_-]?key|db[_-]?password)\s*[:=]\s*["'][A-Za-z0-9_+/=-]{8,}["']/i;

/**
 * Scan the full git history of `repoRoot` (defaults to the monorepo root) and
 * return every violation found. An empty return means no provider secret,
 * service credential, database key, or plaintext token literal is present in
 * any historical commit.
 */
export function grepGitHistory(repoRoot?: string): HistoryViolation[] {
  const root = repoRoot ?? resolveRepoRoot();
  const violations: HistoryViolation[] = [];
  const seenBlobs = new Set<string>();

  // `git log --all -p` emits a unified diff for every commit. We parse the
  // commit header and the added lines (+ prefix) in each hunk.
  const raw = execSync('git log --all -p --no-color --format=nulcommit%x00%H%x00%s', {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 100 * 1024 * 1024,
  });

  let commit = '';
  let path = '';

  for (const line of raw.split('\n')) {
    if (line.startsWith('nulcommit\x00')) {
      const parts = line.split('\x00');
      commit = parts[1] ?? '';
      path = '';
      continue;
    }
    if (line.startsWith('diff --git')) {
      const m = line.match(/^diff --git a\/(.+) b\/(.+)$/);
      if (m) path = m[2]!;
      continue;
    }
    // Only scan added lines in diffs.
    if (!line.startsWith('+') || line.startsWith('+++')) continue;
    if (!path || isAllowListedPath(path)) continue;

    const text = line.slice(1); // strip the leading +
    if (isNameOnlyReference(text)) continue;

    for (const pattern of [HIGH_ENTROPY, ASSIGNMENT]) {
      if (pattern.test(text)) {
        // Deduplicate by (path, pattern, text) so the same blob committed
        // across multiple commits is only reported once.
        const dedupeKey = `${path}:${pattern.source}:${text.trim().slice(0, 120)}`;
        if (seenBlobs.has(dedupeKey)) break;
        seenBlobs.add(dedupeKey);
        violations.push({
          commit,
          path,
          line: 0, // diff line number within the file is not meaningful here
          pattern: pattern.source,
          text: text.trim().slice(0, 120),
        });
        break;
      }
    }
  }
  return violations;
}

function resolveRepoRoot(): string {
  return execSync('git rev-parse --show-toplevel', { encoding: 'utf8' }).trim();
}

function isAllowListedPath(path: string): boolean {
  return (
    path.startsWith('node_modules/') ||
    path.startsWith('dist/') ||
    path.startsWith('.git/') ||
    path.endsWith('.lock') ||
    path.endsWith('secrets-check.ts') ||
    path.endsWith('secrets-grep.ts') ||
    path.endsWith('secrets-history.ts') ||
    path.endsWith('provider-secrets.ts') ||
    path.endsWith('secrets-grep.test.ts') ||
    path.endsWith('secrets-history.test.ts') ||
    path.endsWith('.env.example') ||
    path.endsWith('pnpm-lock.yaml') ||
    path.endsWith('README.md') ||
    path.endsWith('CONTEXT.md') ||
    path.endsWith('RELEASE_GATES.md')
  );
}

/**
 * Heuristic: a line like `process.env.DATABASE_URL` or `CLERK_SECRET: string`
 * references the name but does not leak a value. We skip lines where the
 * secret name is a bare reference or placeholder.
 */
function isNameOnlyReference(text: string): boolean {
  const reference = PROVIDER_SECRET_PATTERN.source;
  const nameRef = new RegExp(
    `(?:process\\.env\\.)?(?:${reference})(?:[A-Z0-9_]*)\\s*[:=]\\s*` +
      `(?:undefined|null|''|""|\\{\\{|process\\.env\\.|env\\.|[A-Z_]+\\})`,
    'i',
  );
  return nameRef.test(text) && !HIGH_ENTROPY.test(text);
}

/** CLI entrypoint: print violations and exit non-zero if any are found. */
export function main(): void {
  const violations = grepGitHistory();
  if (violations.length === 0) {
    console.log('No provider secrets found in git history.');
    return;
  }
  console.error('Provider secrets found in git history:');
  for (const v of violations) {
    console.error(`  ${v.commit.slice(0, 8)} ${v.path}  [${v.pattern}]  ${v.text}`);
  }
  process.exit(1);
}
