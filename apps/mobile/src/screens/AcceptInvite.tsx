import { useState } from 'react';
import { Pressable, ScrollView, Text, TextInput } from 'react-native';
import { useApi } from '../lib/api';
import { ApiError } from '../lib/api';
import { styles } from '../components/ui';

/**
 * Accept a phone-bound Household Invite (issue 03 — the mobile half of invite
 * acceptance). The Owner delivers a single-use token through WhatsApp, either
 * as a tappable `cooklink://invite?token=...` deep link or as a copyable code.
 * Here the recipient pastes (or has pre-filled) the token and submits it to
 * `/v1/invites/accept`, which enforces the matching-phone, single-use, and
 * Cook-limit rules on the server.
 *
 * Every server error code is surfaced as a plain-English sentence so the
 * person knows what to do next (sign in with the invited phone, ask the owner
 * to resend, etc.). A network failure is reported distinctly from an access
 * denial so it is never mistaken for "you were removed".
 */
const ACCEPTANCE_MESSAGES: Record<string, string> = {
  token_required: 'Paste the invite token the owner sent you.',
  invite_invalid:
    'This invite is no longer valid. It may have expired, been revoked, or already been used.',
  invite_consumed: 'This invite has already been used.',
  invite_phone_mismatch:
    'This invite was sent to a different phone number. Sign in with the number the owner invited.',
  already_member: 'You are already a member of this household.',
  household_role_already_exists: 'You already have a role in this household.',
  household_cook_limit_reached: 'This household already has two active cooks.',
  cook_household_limit_reached: 'You already cook for 30 households and cannot add more.',
};

function messageFor(err: unknown): string {
  if (err instanceof ApiError) {
    let body: { error?: unknown } = {};
    try {
      body = JSON.parse(err.body) as { error?: unknown };
    } catch {
      // Non-JSON error body; fall through to the status line below.
    }
    const code = typeof body.error === 'string' ? body.error : '';
    if (code && ACCEPTANCE_MESSAGES[code]) return ACCEPTANCE_MESSAGES[code]!;
    return `Could not accept the invite (${err.status}).`;
  }
  // No ApiError means the request never reached the server.
  return 'Could not reach Cooklink. Check your connection and try again.';
}

export function AcceptInvite({
  prefillToken,
  onAccepted,
  onCancel,
}: {
  prefillToken: string;
  onAccepted: (householdId: string, role: string) => void | Promise<void>;
  onCancel: () => void;
}) {
  const api = useApi();
  const [token, setToken] = useState(prefillToken);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  async function accept() {
    const trimmed = token.trim();
    if (!trimmed) {
      setError(ACCEPTANCE_MESSAGES['token_required']!);
      return;
    }
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const result = await api<{ householdId: string; role: string }>('/v1/invites/accept', {
        method: 'POST',
        body: JSON.stringify({ token: trimmed }),
      });
      setNotice('You joined the household.');
      await onAccepted(result.householdId, result.role);
    } catch (err) {
      setError(messageFor(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <ScrollView contentContainerStyle={styles.screen}>
      <Text style={styles.eyebrow}>Invite</Text>
      <Text style={styles.title}>Accept a household invite</Text>
      <Text style={styles.subtitle}>
        Paste the invite token the household owner sent you through WhatsApp.
      </Text>
      <TextInput
        accessibilityLabel="Invite token"
        style={styles.input}
        value={token}
        onChangeText={setToken}
        placeholder="Invite token"
        autoCapitalize="none"
        autoCorrect={false}
      />
      {error ? <Text style={styles.error}>{error}</Text> : null}
      {notice ? <Text style={styles.subtitle}>{notice}</Text> : null}
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Accept invite"
        style={[styles.primaryButton, busy && styles.disabled]}
        disabled={busy}
        onPress={accept}
      >
        <Text style={styles.primaryButtonText}>{busy ? 'Accepting' : 'Accept invite'}</Text>
      </Pressable>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Cancel"
        style={styles.ghostButton}
        onPress={onCancel}
      >
        <Text style={styles.ghostButtonText}>Cancel</Text>
      </Pressable>
    </ScrollView>
  );
}
