import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Issue 13, AC#2 — accessibility enforcement.
 *
 * VoiceOver/TalkBack testing is manual, but the structural contracts that make
 * those tests pass can be verified automatically:
 *
 * 1. Touch targets meet the 44-pt iOS / 48-dp Android floor.
 * 2. Colour combinations for text meet WCAG AA contrast (4.5:1 for normal
 *    text, 3:1 for large text).
 * 3. State is communicated non-colour-only (accessibilityState on Pressables,
 *    not just a visual tint).
 * 4. Every Pressable has an accessibilityRole and accessibilityLabel.
 *
 * These tests parse the source statically because React Native components
 * cannot render in a Node test environment.
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC_DIR = join(__dirname, '..');

function readSrc(rel: string): string {
  return readFileSync(join(SRC_DIR, rel), 'utf8');
}

function listScreens(): string[] {
  const screensDir = join(SRC_DIR, 'screens');
  return readdirSync(screensDir)
    .filter((f) => f.endsWith('.tsx'))
    .map((f) => `screens/${f}`);
}

// ---- Colour contrast helpers ----

function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const m = hex.replace('#', '');
  return {
    r: parseInt(m.slice(0, 2), 16),
    g: parseInt(m.slice(2, 4), 16),
    b: parseInt(m.slice(4, 6), 16),
  };
}

function relativeLuminance({ r, g, b }: { r: number; g: number; b: number }): number {
  const toLinear = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * toLinear(r) + 0.7152 * toLinear(g) + 0.0722 * toLinear(b);
}

function contrastRatio(fg: string, bg: string): number {
  const l1 = relativeLuminance(hexToRgb(fg));
  const l2 = relativeLuminance(hexToRgb(bg));
  const lighter = Math.max(l1, l2);
  const darker = Math.min(l1, l2);
  return (lighter + 0.05) / (darker + 0.05);
}

// Extract the colours object from the design system source
const uiSource = readSrc('components/design-system.tsx');

const COLORS: Record<string, string> = {};
const colorLines = uiSource.match(/(\w+):\s*'(#[0-9a-fA-F]{6})'/g);
if (colorLines) {
  for (const line of colorLines) {
    const m = line.match(/(\w+):\s*'(#[0-9a-fA-F]{6})'/);
    if (m) COLORS[m[1]!] = m[2]!;
  }
}

// ---- Tests ----

test('AC#2: colour palette is extracted and non-empty', () => {
  assert.ok(
    Object.keys(COLORS).length >= 5,
    'should extract at least 5 colours from design-system.tsx',
  );
  assert.ok(COLORS.ink, 'ink colour must exist');
  assert.ok(COLORS.surface, 'surface colour must exist');
  assert.ok(COLORS.accent, 'accent colour must exist');
});

test('AC#2: ink text on surface/card meets WCAG AA contrast (4.5:1)', () => {
  const inkOnSurface = contrastRatio(COLORS.ink!, COLORS.surface!);
  assert.ok(
    inkOnSurface >= 4.5,
    `ink on surface contrast ${inkOnSurface.toFixed(2)}:1 is below WCAG AA 4.5:1`,
  );
  const inkOnCard = contrastRatio(COLORS.ink!, COLORS.card!);
  assert.ok(
    inkOnCard >= 4.5,
    `ink on card contrast ${inkOnCard.toFixed(2)}:1 is below WCAG AA 4.5:1`,
  );
});

test('AC#2: inkSoft text on surface/card meets WCAG AA contrast (4.5:1)', () => {
  const inkSoftOnSurface = contrastRatio(COLORS.inkSoft!, COLORS.surface!);
  assert.ok(
    inkSoftOnSurface >= 4.5,
    `inkSoft on surface contrast ${inkSoftOnSurface.toFixed(2)}:1 is below WCAG AA 4.5:1`,
  );
  const inkSoftOnCard = contrastRatio(COLORS.inkSoft!, COLORS.card!);
  assert.ok(
    inkSoftOnCard >= 4.5,
    `inkSoft on card contrast ${inkSoftOnCard.toFixed(2)}:1 is below WCAG AA 4.5:1`,
  );
});

test('AC#2: primary button text (white) on accent meets WCAG AA contrast (4.5:1)', () => {
  const whiteOnAccent = contrastRatio('#ffffff', COLORS.accent!);
  assert.ok(
    whiteOnAccent >= 4.5,
    `white on accent contrast ${whiteOnAccent.toFixed(2)}:1 is below WCAG AA 4.5:1`,
  );
});

test('AC#2: danger text on surface/card meets WCAG AA contrast (4.5:1)', () => {
  const dangerOnSurface = contrastRatio(COLORS.danger!, COLORS.surface!);
  assert.ok(
    dangerOnSurface >= 4.5,
    `danger on surface contrast ${dangerOnSurface.toFixed(2)}:1 is below WCAG AA 4.5:1`,
  );
  const dangerOnCard = contrastRatio(COLORS.danger!, COLORS.card!);
  assert.ok(
    dangerOnCard >= 4.5,
    `danger on card contrast ${dangerOnCard.toFixed(2)}:1 is below WCAG AA 4.5:1`,
  );
});

test('AC#2: brand text on surface meets WCAG AA contrast (4.5:1)', () => {
  const brandOnSurface = contrastRatio(COLORS.brand!, COLORS.surface!);
  assert.ok(
    brandOnSurface >= 4.5,
    `brand on surface contrast ${brandOnSurface.toFixed(2)}:1 is below WCAG AA 4.5:1`,
  );
});

test('AC#2: bottom tab minHeight meets 44pt touch-target floor', () => {
  const m = uiSource.match(/tab:\s*\{[^}]*minHeight:\s*(\d+)/);
  assert.ok(m, 'tab style must define minHeight');
  const minH = parseInt(m[1]!, 10);
  assert.ok(minH >= 44, `tab minHeight ${minH} is below the 44pt touch-target floor`);
});

test('AC#2: chat header action minHeight meets 44pt touch-target floor', () => {
  const m = uiSource.match(/button:\s*\{[^}]*minHeight:\s*(\d+)/);
  assert.ok(m, 'chat header button style must define minHeight');
  const minH = parseInt(m[1]!, 10);
  assert.ok(minH >= 44, `chat header minHeight ${minH} is below the 44pt touch-target floor`);
});

test('AC#2: primary button padding meets 44pt touch-target floor', () => {
  // primaryButton has padding: 16 (top + bottom = 32) + line height of 17pt text
  // = ~49pt total. Verify the padding is at least 14 (14*2 + 17 = 45).
  const m = uiSource.match(/primaryButton:\s*\{[^}]*padding:\s*(\d+)/);
  assert.ok(m, 'primaryButton style must define padding');
  const padding = parseInt(m[1]!, 10);
  assert.ok(
    padding * 2 + 17 >= 44,
    `primaryButton vertical extent ${padding * 2 + 17}pt is below the 44pt floor`,
  );
});

test('AC#2: BottomTabs Pressables have accessibilityRole, accessibilityState, and accessibilityLabel', () => {
  const source = readSrc('components/design-system.tsx');
  // Find the BottomTabs function body
  const fnStart = source.indexOf('export function BottomTabs');
  assert.ok(fnStart >= 0, 'BottomTabs component must exist');
  const fnBody = source.slice(fnStart);
  assert.ok(fnBody.includes('accessibilityRole='), 'BottomTabs must use accessibilityRole');
  assert.ok(
    fnBody.includes('accessibilityState='),
    'BottomTabs must use accessibilityState for non-colour state',
  );
  assert.ok(fnBody.includes('accessibilityLabel='), 'BottomTabs must use accessibilityLabel');
});

test('AC#2: ChatHeaderAction has accessibilityRole and accessibilityLabel', () => {
  const source = readSrc('components/design-system.tsx');
  const fnStart = source.indexOf('export function ChatHeaderAction');
  assert.ok(fnStart >= 0, 'ChatHeaderAction component must exist');
  const fnBody = source.slice(fnStart);
  assert.ok(fnBody.includes('accessibilityRole='), 'ChatHeaderAction must use accessibilityRole');
  assert.ok(fnBody.includes('accessibilityLabel='), 'ChatHeaderAction must use accessibilityLabel');
});

test('AC#2: every Pressable in every screen has accessibilityRole', () => {
  const screens = listScreens();
  for (const screen of screens) {
    const source = readSrc(screen);
    // Find all Pressable usages
    const pressableMatches = source.match(/<Pressable/g);
    if (!pressableMatches) continue;
    const pressableCount = pressableMatches.length;
    // Count how many have accessibilityRole
    const roleCount = (source.match(/accessibilityRole=/g) || []).length;
    assert.ok(
      roleCount >= pressableCount,
      `${screen}: ${pressableCount} Pressables but only ${roleCount} accessibilityRole props`,
    );
  }
});

test('AC#2: segment controls in MemberShell use accessibilityRole (non-colour state)', () => {
  const source = readSrc('screens/MemberShell.tsx');
  // The Cook/Member segment selectors are Pressables with accessibilityRole
  const segmentSection = source.slice(source.indexOf('styles.segment'));
  assert.ok(
    segmentSection.includes('accessibilityRole='),
    'segment controls must have accessibilityRole for non-colour state',
  );
});

test('Week Switcher exposes each day as a labelled selected-state control', () => {
  const source = readSrc('screens/MemberShell.tsx');
  const weekSwitcher = source.slice(source.indexOf('function WeekDayButton'));
  assert.ok(weekSwitcher.includes('accessibilityRole="button"'));
  assert.ok(weekSwitcher.includes('accessibilityLabel={`${day.relativeLabel}, ${day.fullLabel}`}'));
  assert.ok(weekSwitcher.includes('accessibilityState={selected'));
});

test('Week Switcher filters the Today feed and updates its meal heading', () => {
  const source = readSrc('screens/MemberShell.tsx');
  assert.ok(source.includes('meal.date === selectedDate'));
  assert.ok(source.includes('{mealsTitle(selectedDay)}'));
  assert.ok(source.includes('setSelectedDate'));
});

test('AC#2: Chat back button meets 44pt touch-target floor', () => {
  const source = readSrc('screens/Chat.tsx');
  const m = source.match(/back:\s*\{[^}]*minHeight:\s*(\d+)/);
  assert.ok(m, 'Chat back button style must define minHeight');
  const minH = parseInt(m[1]!, 10);
  assert.ok(minH >= 44, `Chat back minHeight ${minH} is below the 44pt touch-target floor`);
});

test('AC#2: Chat send/record buttons have accessibilityLabel', () => {
  const source = readSrc('screens/Chat.tsx');
  assert.ok(
    source.includes('accessibilityLabel="Send message"'),
    'Chat must label the send button',
  );
  assert.ok(
    source.includes("voice.phase === 'recording' ? 'Stop recording' : 'Record voice note'"),
    'Chat must label the record button with recording state',
  );
});

test('AC#2: Chat photo viewer has accessibilityLabel', () => {
  const source = readSrc('screens/Chat.tsx');
  assert.ok(
    source.includes('accessibilityLabel="Photo from household chat"'),
    'Chat photo viewer must have accessibilityLabel',
  );
});

test('AC#2: MealPlan meal rows have accessibilityLabel with meal type and name', () => {
  const source = readSrc('screens/MealPlan.tsx');
  assert.ok(
    source.includes('accessibilityLabel={`${meal.mealType} ${meal.name}`}'),
    'MealPlan meal rows must have accessibilityLabel with meal type and name',
  );
});

test('AC#2: CookShell household list items have accessibilityLabel', () => {
  const source = readSrc('screens/CookShell.tsx');
  assert.ok(
    source.includes('accessibilityLabel={`Open ${household.name} chat`}'),
    'CookShell household list must have accessibilityLabel',
  );
});

test('AC#2: invite phone input has accessibilityLabel', () => {
  const source = readSrc('screens/MemberShell.tsx');
  assert.ok(
    source.includes('accessibilityLabel="Invite phone number"'),
    'Invite phone input must have accessibilityLabel',
  );
});

test('AC#2: AcceptInvite token input and buttons have accessibilityLabel', () => {
  const source = readSrc('screens/AcceptInvite.tsx');
  assert.ok(
    source.includes('accessibilityLabel="Invite token"'),
    'AcceptInvite token input must have accessibilityLabel',
  );
  assert.ok(
    source.includes('accessibilityLabel="Accept invite"'),
    'AcceptInvite accept button must have accessibilityLabel',
  );
  assert.ok(
    source.includes('accessibilityLabel="Cancel"'),
    'AcceptInvite cancel button must have accessibilityLabel',
  );
});

// ---- Issue 03 invite-acceptance + access-probe contracts (static) ----
// React Native hooks cannot execute in a Node test environment, so these
// assert the structural contracts that make the runtime behavior correct.

test('issue 03: useAccessProbe rechecks only on a definitive 403/404 denial', () => {
  const source = readSrc('lib/households.ts');
  // Must import ApiError so a network failure is not mistaken for revoked.
  assert.ok(source.includes('ApiError'), 'useAccessProbe must import ApiError');
  // Must gate revoked on 403/404, never on every catch.
  assert.ok(
    /err\.status === 403 \|\| err\.status === 404/.test(source),
    'useAccessProbe must only set revoked on 403/404',
  );
});

test('issue 03: useAccessProbe re-probes when the app returns to the foreground', () => {
  const source = readSrc('lib/households.ts');
  assert.ok(source.includes("AppState.addEventListener('change'"), 'must subscribe to AppState');
  assert.ok(source.includes("state === 'active'"), 'must re-probe on active state');
});

test('issue 03: AcceptInvite posts the token to the invite-accept endpoint', () => {
  const source = readSrc('screens/AcceptInvite.tsx');
  assert.ok(source.includes("'/v1/invites/accept'"), 'must call the accept endpoint');
  assert.ok(source.includes('JSON.stringify({ token'), 'must send the token in the body');
});

test('issue 03: the WhatsApp invite message carries a cooklink:// deep link', () => {
  const source = readSrc('screens/MemberShell.tsx');
  assert.ok(
    source.includes('cooklink://invite?token='),
    'the owner invite message must include a tappable cooklink:// deep link',
  );
});

// ---- Issue 03: invite token preservation through OTP + foreground probe ----

test('issue 03: invite route preserves the token through OTP for unsigned-in visitors', () => {
  const source = readFileSync(join(SRC_DIR, '..', 'app', 'invite.tsx'), 'utf8');
  // Must redirect to / with pending_invite_token, not bare /, so the token
  // survives the OTP flow and the home route can redirect back after sign-in.
  assert.ok(
    source.includes('pending_invite_token='),
    'invite route must carry the token as pending_invite_token for unsigned-in visitors',
  );
  assert.ok(
    /encodeURIComponent\(prefillToken\)/.test(source),
    'invite route must URL-encode the token when redirecting',
  );
});

test('issue 03: home route reads pending_invite_token and redirects to /invite after sign-in', () => {
  const source = readFileSync(join(SRC_DIR, '..', 'app', 'index.tsx'), 'utf8');
  assert.ok(
    source.includes('pending_invite_token'),
    'home route must read the pending_invite_token query param',
  );
  assert.ok(
    source.includes('/invite?token='),
    'home route must redirect to /invite with the preserved token after sign-in',
  );
});

test('issue 03/04: useAccessProbe runs a periodic foreground re-probe while the app is active', () => {
  const source = readSrc('lib/households.ts');
  assert.ok(
    source.includes('FOREGROUND_PROBE_INTERVAL_MS'),
    'useAccessProbe must define a foreground probe interval constant',
  );
  assert.ok(
    source.includes('setInterval'),
    'useAccessProbe must start an interval while the app is in the foreground',
  );
  assert.ok(
    /state === 'active'/.test(source) && /clearInterval/.test(source),
    'useAccessProbe must clear the interval when the app leaves the foreground',
  );
});
