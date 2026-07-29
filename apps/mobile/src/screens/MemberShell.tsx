import { useEffect, useState } from 'react';
import { Linking, StyleSheet, Text, TextInput, View } from 'react-native';
import { useApi } from '../lib/api';
import {
  useAccessProbe,
  type HouseholdMember,
  type HouseholdSummary,
  type InviteSummary,
  type PlannedMeal,
} from '../lib/households';
import {
  Avatar,
  Card,
  ChatHeaderAction,
  Chip,
  Divider,
  FadeSlideIn,
  Message,
  PotLoader,
  PressableScale,
  BottomTabs,
  TabBarMinimizeProvider,
  TabScrollView,
  colors,
  fonts,
  mealAccent,
  radius,
  shadow,
  space,
  styles,
  type TabKey,
  type TabSpec,
} from '../components/ui';
import { Mascot } from '../components/Mascot';
import { MealPlanScreen } from './MealPlan';
import { GroceriesScreen } from './Groceries';
import { ChatScreen } from './Chat';

const MEMBER_TABS: readonly TabSpec[] = [
  { key: 'today', label: 'Today', icon: 'plate' },
  { key: 'mealPlan', label: 'Meal Plan', icon: 'calendar' },
  { key: 'groceries', label: 'Groceries', icon: 'basket' },
];

/**
 * The Household Member / Owner entry shell (issue 03 — Variant A). Launches
 * into Today, with Today, Meal Plan, and Groceries as the three persistent
 * destinations. Household Chat is a header action over the current tab; back
 * from Chat returns to that tab. Switching tabs never changes Household
 * context.
 *
 * The owner additionally sees a membership management surface (invite, list,
 * revoke, resend, remove) in the Today destination so they can bring in
 * Members and Cooks.
 */
export function MemberShell({ household }: { household: HouseholdSummary }) {
  const [tab, setTab] = useState<TabKey>('today');
  const [chatOpen, setChatOpen] = useState(false);
  const { revoked } = useAccessProbe(household.id);

  // A removed member exits immediately with a plain explanation (issue 03).
  if (revoked)
    return (
      <Message
        title="Access changed"
        body={`You no longer have access to ${household.name}. Ask the household owner to invite you again.`}
      />
    );

  if (chatOpen) {
    return <ChatScreen household={household} backLabel="Back" onBack={() => setChatOpen(false)} />;
  }

  return (
    <TabBarMinimizeProvider>
      <View style={shell.root}>
        <View style={shell.header}>
          <Avatar name={household.name} size={42} />
          <View style={shell.headerText}>
            <Text style={shell.headerName} numberOfLines={1}>
              {household.name}
            </Text>
            <Text style={shell.headerRole}>
              {household.role === 'owner' ? 'Household owner' : 'Household member'}
            </Text>
          </View>
          <ChatHeaderAction onPress={() => setChatOpen(true)} />
        </View>
        {tab === 'today' ? (
          <MemberToday household={household} />
        ) : tab === 'mealPlan' ? (
          <MealPlanScreen household={household} />
        ) : (
          <GroceriesScreen household={household} />
        )}
        <BottomTabs tabs={MEMBER_TABS} active={tab} onSelect={setTab} />
      </View>
    </TabBarMinimizeProvider>
  );
}

function greetingFor(date: Date): string {
  const hour = date.getHours();
  if (hour < 12) return 'Good morning';
  if (hour < 17) return 'Good afternoon';
  return 'Good evening';
}

function MemberToday({ household }: { household: HouseholdSummary }) {
  const api = useApi();
  const [meals, setMeals] = useState<PlannedMeal[] | null>(null);
  const [members, setMembers] = useState<HouseholdMember[]>([]);
  const [invites, setInvites] = useState<InviteSummary[]>([]);
  const [changed, setChanged] = useState(0);

  useEffect(() => {
    setMeals(null);
    api<{ meals: PlannedMeal[] }>(`/v1/households/${household.id}/meal-plan`).then((data) =>
      setMeals(data.meals),
    );
    if (household.role === 'owner') {
      api<{ members: HouseholdMember[] }>(`/v1/households/${household.id}/members`).then((data) =>
        setMembers(data.members),
      );
      api<{ invites: InviteSummary[] }>(`/v1/households/${household.id}/invites`).then((data) =>
        setInvites(data.invites),
      );
    }
  }, [api, household.id, changed]);

  const now = new Date();
  const today = now.toISOString().slice(0, 10);
  const todayMeals = (meals ?? []).filter((m) => m.date === today);
  const dateLabel = now.toLocaleDateString(undefined, {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
  });

  return (
    <TabScrollView contentContainerStyle={today_.scroll} showsVerticalScrollIndicator={false}>
      {/* The greeting hero: who is cooking, when, and how much is planned. */}
      <FadeSlideIn>
        <View style={today_.hero}>
          <View style={today_.heroText}>
            <Text style={today_.heroDate}>{dateLabel}</Text>
            <Text style={today_.heroGreeting}>{greetingFor(now)}</Text>
            <Text style={today_.heroBody}>
              {meals === null
                ? 'Checking the kitchen…'
                : todayMeals.length > 0
                  ? `${todayMeals.length} meals planned for today.`
                  : 'Nothing planned yet for today.'}
            </Text>
          </View>
          <View style={today_.heroMascot}>
            <Mascot size={112} />
          </View>
        </View>
      </FadeSlideIn>

      <FadeSlideIn delay={90}>
        <View style={today_.sectionHead}>
          <Text style={styles.eyebrow}>On the table</Text>
          <Text style={styles.sectionTitle}>Today&apos;s meals</Text>
        </View>
      </FadeSlideIn>

      {meals === null ? (
        <PotLoader label="Reading the meal plan" />
      ) : todayMeals.length > 0 ? (
        todayMeals.map((meal, i) => (
          <FadeSlideIn key={meal.id} delay={140 + i * 70}>
            <MealCard meal={meal} />
          </FadeSlideIn>
        ))
      ) : (
        <FadeSlideIn delay={140}>
          <Card>
            <Text style={styles.subtitle}>
              No meals planned for today. Open Meal Plan to generate the week.
            </Text>
          </Card>
        </FadeSlideIn>
      )}

      {household.role === 'owner' ? (
        <FadeSlideIn delay={260}>
          <OwnerMembership
            household={household}
            members={members}
            invites={invites}
            onChanged={() => setChanged((n) => n + 1)}
          />
        </FadeSlideIn>
      ) : null}
    </TabScrollView>
  );
}

/**
 * One planned meal as a card. The tinted glyph disc carries the meal type in
 * colour and in shape, so breakfast, lunch, and dinner are distinguishable
 * without relying on the label alone.
 */
function MealCard({ meal }: { meal: PlannedMeal }) {
  const accent = mealAccent(meal.mealType);
  return (
    <View style={today_.mealCard}>
      <View style={[today_.mealGlyph, { backgroundColor: accent.tint }]}>
        <Text style={today_.mealGlyphText}>{accent.glyph}</Text>
      </View>
      <View style={today_.mealBody}>
        <Text style={[styles.mealType, { color: accent.label }]}>{meal.mealType}</Text>
        <Text style={today_.mealName}>{meal.name}</Text>
      </View>
      {meal.isSpecial ? <Chip label="Special" tint={colors.brandSoft} ink={colors.brand} /> : null}
    </View>
  );
}

/**
 * The Owner's membership management surface (issue 03). Create role-specific
 * invites, list pending invites, resend (fresh token), revoke, and remove a
 * Member or Cook. Cook invites enforce the household's two-Cook limit on the
 * server.
 */
function OwnerMembership({
  household,
  members,
  invites,
  onChanged,
}: {
  household: HouseholdSummary;
  members: HouseholdMember[];
  invites: InviteSummary[];
  onChanged: () => void;
}) {
  const api = useApi();
  const [phone, setPhoneState] = useState('');
  const [role, setRole] = useState<'member' | 'cook'>('cook');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Open WhatsApp with a pre-filled invite message so the Owner delivers the
  // token through WhatsApp as required (issue 03 — invites are shared through
  // WhatsApp). The message includes a tappable cooklink:// deep link so the
  // recipient can accept in one tap; the token is also shown as a fallback for
  // manual entry when the app is not yet installed or the link cannot open.
  async function sendViaWhatsApp(
    invitePhone: string,
    inviteToken: string,
    inviteRole: 'member' | 'cook',
  ) {
    const normalized = invitePhone.replace(/[^\d]/g, '');
    const deepLink = `cooklink://invite?token=${encodeURIComponent(inviteToken)}`;
    const message = `You're invited to join ${household.name} as a ${inviteRole} on Cooklink. Tap to accept: ${deepLink} (or open Cooklink and enter token: ${inviteToken})`;
    const url = `https://wa.me/${normalized}?text=${encodeURIComponent(message)}`;
    try {
      const canOpen = await Linking.canOpenURL(url);
      if (canOpen) {
        await Linking.openURL(url);
        setNotice(`WhatsApp opened with the ${inviteRole} invite message.`);
        return;
      }
    } catch {
      // Fall through to the manual fallback below.
    }
    setNotice(`WhatsApp is not available. Share this link with the ${inviteRole}: ${deepLink}`);
  }

  async function createInvite() {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const result = await api<{ token: string }>(`/v1/households/${household.id}/invites`, {
        method: 'POST',
        body: JSON.stringify({ phone, role }),
      });
      await sendViaWhatsApp(phone, result.token, role);
      setPhoneState('');
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not create the invite.');
    } finally {
      setBusy(false);
    }
  }

  async function resend(inviteId: string) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const result = await api<{ token: string; role: 'member' | 'cook' }>(
        `/v1/invites/${inviteId}/resend`,
        { method: 'POST' },
      );
      // The invite's phone is masked in the list; use the raw phone the owner
      // entered for the WhatsApp link. If the owner navigated away, fall back
      // to displaying the token.
      const invitePhone = phone || '';
      await sendViaWhatsApp(invitePhone, result.token, result.role);
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not resend the invite.');
    } finally {
      setBusy(false);
    }
  }

  async function revoke(inviteId: string) {
    setBusy(true);
    setError(null);
    try {
      await api<{ ok: boolean }>(`/v1/invites/${inviteId}`, { method: 'DELETE' });
      setNotice('Invite revoked.');
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not revoke the invite.');
    } finally {
      setBusy(false);
    }
  }

  async function remove(membershipId: string) {
    setBusy(true);
    setError(null);
    try {
      await api<{ ok: boolean }>(`/v1/households/${household.id}/members/${membershipId}`, {
        method: 'DELETE',
      });
      setNotice('Access removed.');
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not remove access.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <View style={owner.wrap}>
      <View style={today_.sectionHead}>
        <Text style={styles.eyebrow}>Owner</Text>
        <Text style={styles.sectionTitle}>Who is in this household</Text>
      </View>

      <Card>
        <Text style={styles.cardTitle}>Invite someone</Text>
        <View style={styles.segment}>
          <PressableScale
            accessibilityRole="button"
            accessibilityLabel="Invite a cook"
            accessibilityState={{ selected: role === 'cook' }}
            style={[styles.segmentButton, role === 'cook' && styles.segmentActive]}
            onPress={() => setRole('cook')}
          >
            <Text style={[styles.segmentText, role === 'cook' && styles.segmentTextActive]}>
              Cook
            </Text>
          </PressableScale>
          <PressableScale
            accessibilityRole="button"
            accessibilityLabel="Invite a member"
            accessibilityState={{ selected: role === 'member' }}
            style={[styles.segmentButton, role === 'member' && styles.segmentActive]}
            onPress={() => setRole('member')}
          >
            <Text style={[styles.segmentText, role === 'member' && styles.segmentTextActive]}>
              Member
            </Text>
          </PressableScale>
        </View>
        <Text style={styles.subtitle}>
          Cooklink sends the invite over WhatsApp. It only works from this phone number.
        </Text>
        <InvitePhoneInput value={phone} onChange={setPhoneState} />
        <PressableScale
          accessibilityRole="button"
          accessibilityLabel={`Create ${role} invite`}
          style={[styles.primaryButton, busy && styles.disabled]}
          disabled={busy}
          onPress={createInvite}
        >
          <Text style={styles.primaryButtonText}>
            {busy ? 'Creating…' : `Create ${role} invite`}
          </Text>
        </PressableScale>
        {error ? <Text style={styles.error}>{error}</Text> : null}
        {notice ? <Text style={styles.subtitle}>{notice}</Text> : null}
      </Card>

      {invites.length > 0 ? (
        <Card>
          <Text style={styles.cardTitle}>Pending invites</Text>
          {invites.map((invite, i) => (
            <View key={invite.id}>
              {i > 0 ? <Divider /> : null}
              <View style={owner.row}>
                <View style={owner.rowText}>
                  <Chip
                    label={invite.role}
                    tint={invite.role === 'cook' ? colors.accentSoft : colors.brandSoft}
                    ink={invite.role === 'cook' ? colors.accent : colors.brand}
                  />
                  <Text style={owner.rowLabel}>{invite.phoneMasked}</Text>
                </View>
                <View style={owner.rowActions}>
                  <PressableScale
                    accessibilityRole="button"
                    accessibilityLabel={`Resend invite to ${invite.phoneMasked}`}
                    style={styles.ghostButton}
                    disabled={busy}
                    onPress={() => resend(invite.id)}
                  >
                    <Text style={styles.ghostButtonText}>Resend</Text>
                  </PressableScale>
                  <PressableScale
                    accessibilityRole="button"
                    accessibilityLabel={`Revoke invite to ${invite.phoneMasked}`}
                    style={styles.ghostButton}
                    disabled={busy}
                    onPress={() => revoke(invite.id)}
                  >
                    <Text style={[styles.ghostButtonText, { color: colors.danger }]}>Revoke</Text>
                  </PressableScale>
                </View>
              </View>
            </View>
          ))}
        </Card>
      ) : null}

      <Card>
        <Text style={styles.cardTitle}>Members and cooks</Text>
        {members.map((member, i) => (
          <View key={member.id}>
            {i > 0 ? <Divider /> : null}
            <View style={owner.row}>
              <View style={owner.rowText}>
                <Chip
                  label={member.role}
                  tint={member.role === 'cook' ? colors.accentSoft : colors.brandSoft}
                  ink={member.role === 'cook' ? colors.accent : colors.brand}
                />
                <Text style={owner.rowLabel}>{member.notificationDefault}</Text>
              </View>
              {member.role !== 'owner' ? (
                <PressableScale
                  accessibilityRole="button"
                  accessibilityLabel={`Remove ${member.role} access`}
                  style={styles.ghostButton}
                  disabled={busy}
                  onPress={() => remove(member.id)}
                >
                  <Text style={[styles.ghostButtonText, { color: colors.danger }]}>Remove</Text>
                </PressableScale>
              ) : null}
            </View>
          </View>
        ))}
      </Card>
    </View>
  );
}

// A controlled phone input kept here so the owner surface is one self-contained
// card; extracted to its own component only for clarity.
function InvitePhoneInput({
  value,
  onChange,
}: {
  value: string;
  onChange: (next: string) => void;
}) {
  return (
    <TextInput
      accessibilityLabel="Invite phone number"
      style={styles.input}
      value={value}
      onChangeText={onChange}
      placeholder="+91 phone number"
      placeholderTextColor={colors.inkSoft}
      keyboardType="phone-pad"
    />
  );
}

const shell = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.surface },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    paddingHorizontal: space.xl,
    paddingTop: 58,
    paddingBottom: space.md,
    backgroundColor: colors.surface,
  },
  headerText: { flex: 1 },
  headerName: { fontFamily: fonts.display, fontSize: 20, fontWeight: '700', color: colors.ink },
  headerRole: { fontSize: 12, color: colors.inkSoft, marginTop: 1 },
});

const today_ = StyleSheet.create({
  scroll: {
    paddingHorizontal: space.xl,
    paddingTop: space.sm,
    paddingBottom: space.xxl,
    gap: space.md,
  },

  hero: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    borderRadius: radius.xl,
    backgroundColor: colors.brandSoft,
    paddingLeft: space.xl,
    paddingTop: space.lg,
    paddingRight: space.md,
    ...shadow.soft,
  },
  heroText: { flex: 1, paddingBottom: space.xl, paddingRight: space.sm, gap: 2 },
  heroDate: {
    fontSize: 11,
    fontWeight: '800',
    color: colors.brand,
    textTransform: 'uppercase',
    letterSpacing: 1.1,
  },
  heroGreeting: {
    fontFamily: fonts.display,
    fontSize: 25,
    lineHeight: 30,
    fontWeight: '700',
    color: colors.ink,
  },
  heroBody: { fontSize: 14, lineHeight: 20, color: colors.inkSoft, marginTop: 2 },
  heroMascot: { marginBottom: space.xs },

  sectionHead: { gap: 3, marginTop: space.sm },

  mealCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.lg,
    borderRadius: radius.lg,
    backgroundColor: colors.card,
    padding: space.lg,
    ...shadow.soft,
  },
  mealGlyph: {
    width: 52,
    height: 52,
    borderRadius: 26,
    alignItems: 'center',
    justifyContent: 'center',
  },
  mealGlyphText: { fontSize: 25 },
  mealBody: { flex: 1, gap: 3 },
  mealName: { fontFamily: fonts.display, fontSize: 19, lineHeight: 24, color: colors.ink },
});

const owner = StyleSheet.create({
  wrap: { gap: space.md, marginTop: space.sm },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: space.sm,
    paddingVertical: space.md,
  },
  rowText: { flexDirection: 'row', alignItems: 'center', gap: space.sm, flex: 1 },
  rowLabel: { fontSize: 14, color: colors.inkSoft, flexShrink: 1 },
  rowActions: { flexDirection: 'row', gap: space.sm },
});
