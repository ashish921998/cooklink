import { useCallback, useState } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';
import { useApi } from '../lib/api';
import { ApiError } from '../lib/api';
import {
  Card,
  ErrorNote,
  FadeSlideIn,
  Field,
  PressableScale,
  colors,
  fonts,
  space,
  styles,
} from '../components/design-system';
import { Mascot } from '../components/Mascot';
import { Text, TextInput } from '../components/Typography';

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
  expectedRole,
  onAccepted,
  onCancel,
}: {
  prefillToken: string;
  expectedRole?: 'member' | 'cook';
  onAccepted: (householdId: string, role: string) => void | Promise<void>;
  onCancel: () => void;
}) {
  const api = useApi();
  const [token, setToken] = useState(prefillToken);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const eyebrow =
    expectedRole === 'cook'
      ? 'Hired cook'
      : expectedRole === 'member'
        ? 'Household member'
        : 'Invite';
  const title =
    expectedRole === 'cook'
      ? 'Join a work household'
      : expectedRole === 'member'
        ? 'Join your household'
        : 'Join a household';
  const description =
    expectedRole === 'cook'
      ? 'Paste the WhatsApp invite from the household owner. The invite sets your Cook permissions.'
      : expectedRole === 'member'
        ? 'Paste the WhatsApp invite from your household owner. The invite sets your Member permissions.'
        : 'Paste the invite token the household owner sent you on WhatsApp.';

  const accept = useCallback(async () => {
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
  }, [api, onAccepted, token]);

  return (
    <ScrollView
      testID={`invite-${expectedRole ?? 'generic'}-screen`}
      contentContainerStyle={invite.scroll}
      keyboardShouldPersistTaps="handled"
      showsVerticalScrollIndicator={false}
    >
      <FadeSlideIn>
        <View style={invite.hero}>
          <Mascot size={140} say={notice ? 'Welcome!' : 'Almost in!'} />
        </View>
      </FadeSlideIn>

      <FadeSlideIn delay={100}>
        <View style={invite.head}>
          <Text style={styles.eyebrow}>{eyebrow}</Text>
          <Text style={invite.title}>{title}</Text>
          <Text style={styles.subtitle}>{description}</Text>
        </View>
      </FadeSlideIn>

      <FadeSlideIn delay={180}>
        <Card style={invite.card}>
          <Field
            label="Invite token"
            hint="It only works from the phone number you were invited on."
          >
            <TextInput
              accessibilityLabel="Invite token"
              style={TOKEN_INPUT_STYLE}
              value={token}
              onChangeText={setToken}
              placeholder="Paste token"
              placeholderTextColor={colors.inkSoft}
              autoCapitalize="none"
              autoCorrect={false}
            />
          </Field>
          {error ? <ErrorNote>{error}</ErrorNote> : null}
          {notice ? <Text style={invite.notice}>{notice}</Text> : null}
          <PressableScale
            accessibilityRole="button"
            accessibilityLabel="Accept invite"
            style={busy ? DISABLED_PRIMARY_BUTTON_STYLE : styles.primaryButton}
            disabled={busy}
            onPress={accept}
          >
            <Text style={styles.primaryButtonText}>{busy ? 'Joining…' : 'Accept invite'}</Text>
          </PressableScale>
          <PressableScale
            accessibilityRole="button"
            accessibilityLabel="Cancel"
            style={styles.ghostButton}
            onPress={onCancel}
          >
            <Text style={styles.ghostButtonText}>Cancel</Text>
          </PressableScale>
        </Card>
      </FadeSlideIn>
    </ScrollView>
  );
}

const invite = StyleSheet.create({
  scroll: {
    flexGrow: 1,
    justifyContent: 'center',
    paddingHorizontal: space.xl,
    paddingVertical: space.xxl,
    backgroundColor: colors.surface,
    gap: space.lg,
  },
  hero: { alignItems: 'center' },
  head: { gap: space.xs, alignItems: 'center' },
  title: {
    fontFamily: fonts.display,
    fontSize: 30,
    lineHeight: 35,
    fontWeight: '700',
    color: colors.ink,
    letterSpacing: -0.3,
    textAlign: 'center',
  },
  card: { gap: space.lg },
  tokenInput: { fontSize: 15, letterSpacing: 0.5 },
  notice: { fontSize: 15, fontWeight: '700', color: colors.accent },
});

const TOKEN_INPUT_STYLE = [styles.input, invite.tokenInput];
const DISABLED_PRIMARY_BUTTON_STYLE = [styles.primaryButton, styles.disabled];
