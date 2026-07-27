import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ALLOWED_EXPO_PUBLIC, PROVIDER_SECRET_PATTERN } from './provider-secrets.js';

/**
 * CI grep test (issue 07, AC#7).
 *
 * No Swiggy, AI, ElevenLabs, Clerk secret, or service key may be present in
 * the mobile bundle or any `EXPO_PUBLIC_*` variable. The runtime
 * `secrets-check.ts` guards server env; this scanner guards the *mobile*
 * source tree: it walks `apps/mobile` and fails if it finds a provider-secret
 * literal or an `EXPO_PUBLIC_*` reference to a secret-named variable.
 *
 * Run via `pnpm secrets:grep` and as a node:test in `secrets-grep.test.ts`.
 */

const MOBILE_ROOT = fileURLToPath(new URL('../../mobile', import.meta.url));

/**
 * Provider-secret patterns that must never appear in the mobile bundle. The
 * publishable Clerk key is intentionally allowed (it is a public client key).
 */
const FORBIDDEN_PATTERNS: RegExp[] = [
  PROVIDER_SECRET_PATTERN,
  /\bsk_(test|live)_[A-Za-z0-9]{10,}\b/,
  /\b(ai|api|secret|access|refresh|private)[_a-z]*key\s*[:=]\s*["'][A-Za-z0-9_-]{8,}["']/i,
];

const EXPO_PUBLIC_REF = /EXPO_PUBLIC_[A-Z0-9_]+/g;

/** File extensions scanned for secret literals. */
const SCAN_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.json', '.env', '.env.example']);

export interface GrepViolation {
  file: string;
  line: number;
  pattern: string;
  text: string;
}

function walk(root: string, out: string[]): void {
  for (const entry of readdirSync(root)) {
    if (
      entry === 'node_modules' ||
      entry === '.expo' ||
      entry === 'dist' ||
      entry.startsWith('.git')
    ) {
      continue;
    }
    const full = join(root, entry);
    if (statSync(full).isDirectory()) {
      walk(full, out);
    } else {
      out.push(full);
    }
  }
}

/**
 * Scan the mobile source tree. Returns the list of violations; empty means
 * the bundle is clean of provider secrets.
 */
export function grepMobileSecrets(root: string = MOBILE_ROOT): GrepViolation[] {
  const files: string[] = [];
  walk(root, files);
  const violations: GrepViolation[] = [];

  for (const file of files) {
    const ext = file.slice(file.lastIndexOf('.'));
    const isEnv = file.endsWith('.env') || file.endsWith('.env.example');
    if (!SCAN_EXTENSIONS.has(ext) && !isEnv) continue;
    const rel = relative(root, file);
    const lines = readFileSync(file, 'utf8').split('\n');
    lines.forEach((text, idx) => {
      for (const pattern of FORBIDDEN_PATTERNS) {
        if (pattern.test(text)) {
          violations.push({ file: rel, line: idx + 1, pattern: pattern.source, text: text.trim() });
        }
      }
      for (const match of text.matchAll(EXPO_PUBLIC_REF)) {
        const name = match[0];
        if (!ALLOWED_EXPO_PUBLIC.has(name)) {
          violations.push({
            file: rel,
            line: idx + 1,
            pattern: `forbidden_expo_public:${name}`,
            text: text.trim(),
          });
        }
      }
    });
  }
  return violations;
}

/** CLI entrypoint: print violations and exit non-zero if any are found. */
export function main(): void {
  const violations = grepMobileSecrets();
  if (violations.length === 0) {
    console.log('No provider secrets found in the mobile bundle.');
    return;
  }
  console.error('Provider secrets found in the mobile bundle:');
  for (const v of violations) {
    console.error(`  ${v.file}:${v.line}  [${v.pattern}]  ${v.text}`);
  }
  process.exit(1);
}
