import { useCallback, useEffect, useMemo, useState } from 'react';
import { Image, Linking, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useApi } from '../lib/api';
import { mealImage } from '../lib/meal-images';
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
  radius,
  space,
  styles,
  type TabKey,
  type TabSpec,
} from '../components/design-system';
import { Text, TextInput } from '../components/Typography';
import { MealPlanScreen } from './MealPlan';
import { GroceriesScreen } from './Groceries';
import { ChatScreen } from './Chat';
import heroGradient from '../../assets/hero-gradient.png';

const MEMBER_TABS: readonly TabSpec[] = [
  { key: 'today', label: 'Today', icon: 'plate' },
  { key: 'mealPlan', label: 'Meal Plan', icon: 'calendar' },
  { key: 'groceries', label: 'Groceries', icon: 'basket' },
];

const SELECTED_ACCESSIBILITY_STATE = { selected: true } as const;
const UNSELECTED_ACCESSIBILITY_STATE = { selected: false } as const;
const HERO_TEXT_SOFT = 'rgba(255,255,255,0.88)';
const HERO_TEXT_SHADOW = 'rgba(0,0,0,0.72)';

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
  const insets = useSafeAreaInsets();
  const [tab, setTab] = useState<TabKey>('today');
  const [chatOpen, setChatOpen] = useState(false);
  const [recipeOpen, setRecipeOpen] = useState(false);
  const { revoked } = useAccessProbe(household.id);
  const closeChat = useCallback(() => setChatOpen(false), []);
  const openChat = useCallback(() => setChatOpen(true), []);
  const openMealPlan = useCallback(() => setTab('mealPlan'), []);
  const headerStyle = useMemo(
    () => [shell.header, { paddingTop: insets.top + 10, minHeight: insets.top + 68 }],
    [insets.top],
  );

  // A removed member exits immediately with a plain explanation (issue 03).
  if (revoked)
    return (
      <Message
        title="Access changed"
        body={`You no longer have access to ${household.name}. Ask the household owner to invite you again.`}
      />
    );

  if (chatOpen) {
    return <ChatScreen household={household} backLabel="Back" onBack={closeChat} />;
  }

  return (
    <TabBarMinimizeProvider>
      <View style={shell.root}>
        {!recipeOpen ? (
          <View style={headerStyle}>
            <Avatar name={household.name} size={42} />
            <View style={shell.headerCopy}>
              <Text style={shell.headerName} numberOfLines={1}>
                {household.name}
              </Text>
              <Text style={shell.headerRole}>
                {household.role === 'owner' ? 'Household owner' : 'Household member'}
              </Text>
            </View>
            <ChatHeaderAction onPress={openChat} />
          </View>
        ) : null}
        {tab === 'today' ? (
          <MemberToday household={household} onOpenMealPlan={openMealPlan} />
        ) : tab === 'mealPlan' ? (
          <MealPlanScreen
            household={household}
            includeTopSafeArea={false}
            onRecipeOpenChange={setRecipeOpen}
          />
        ) : (
          <GroceriesScreen household={household} />
        )}
        {!recipeOpen ? <BottomTabs tabs={MEMBER_TABS} active={tab} onSelect={setTab} /> : null}
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

function MemberToday({
  household,
  onOpenMealPlan,
}: {
  household: HouseholdSummary;
  onOpenMealPlan: () => void;
}) {
  const api = useApi();
  const [meals, setMeals] = useState<PlannedMeal[] | null>(null);
  const [members, setMembers] = useState<HouseholdMember[]>([]);
  const [invites, setInvites] = useState<InviteSummary[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [changed, setChanged] = useState(0);
  const markChanged = useCallback(() => setChanged((value) => value + 1), []);

  useEffect(() => {
    setMeals(null);
    setError(null);
    api<{ meals: PlannedMeal[] }>(`/v1/households/${household.id}/meal-plan`)
      .then((data) => setMeals(data.meals))
      .catch((err: unknown) => {
        setMeals([]);
        setError(err instanceof Error ? err.message : "Could not load today's meals.");
      });
    if (household.role === 'owner') {
      api<{ members: HouseholdMember[] }>(`/v1/households/${household.id}/members`)
        .then((data) => setMembers(data.members))
        .catch(() => setMembers([]));
      api<{ invites: InviteSummary[] }>(`/v1/households/${household.id}/invites`)
        .then((data) => setInvites(data.invites))
        .catch(() => setInvites([]));
    }
  }, [api, household.id, household.role, changed]);

  const now = new Date();
  const today = now.toISOString().slice(0, 10);
  const todayMeals = (meals ?? []).filter((m) => m.date === today);
  const nextMeal = chooseNextMeal(todayMeals, now.getHours());
  const otherMeals = todayMeals.filter((meal) => meal.id !== nextMeal?.id);
  const dateLabel = now.toLocaleDateString(undefined, {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
  });

  return (
    <TabScrollView
      testID="today-screen"
      contentContainerStyle={today_.scroll}
      showsVerticalScrollIndicator={false}
    >
      <FadeSlideIn>
        <View style={today_.greeting}>
          <Text style={today_.date}>{dateLabel}</Text>
          <Text style={today_.greetingTitle}>{greetingFor(now)}</Text>
          <Text style={today_.greetingBody}>
            {meals === null
              ? 'Checking the kitchen…'
              : todayMeals.length > 0
                ? `${todayMeals.length} meals planned for today.`
                : 'Nothing planned yet for today.'}
          </Text>
        </View>
      </FadeSlideIn>

      <FadeSlideIn delay={60}>
        <View style={today_.sectionHead}>
          <Text style={styles.eyebrow}>On the table</Text>
          <Text style={today_.sectionTitle}>Today&apos;s meals</Text>
        </View>
      </FadeSlideIn>

      {meals === null ? (
        <PotLoader label="Reading the meal plan" />
      ) : error ? (
        <Card>
          <Text style={styles.cardTitle}>Couldn&apos;t load today</Text>
          <Text style={styles.subtitle}>{error}</Text>
        </Card>
      ) : nextMeal ? (
        <>
          <FadeSlideIn delay={100}>
            <HeroMeal meal={nextMeal} dietStyle={household.dietStyle} />
          </FadeSlideIn>
          {otherMeals.map((meal, index) => (
            <FadeSlideIn key={meal.id} delay={140 + index * 55}>
              <MealCard meal={meal} />
            </FadeSlideIn>
          ))}
        </>
      ) : (
        <FadeSlideIn>
          <Card>
            <Text style={styles.subtitle}>
              No meals planned for today. Open Meal Plan to generate the week.
            </Text>
            <PressableScale
              accessibilityRole="button"
              accessibilityLabel="Open Meal Plan"
              style={styles.primaryButton}
              onPress={onOpenMealPlan}
            >
              <Text style={styles.primaryButtonText}>Open Meal Plan</Text>
            </PressableScale>
          </Card>
        </FadeSlideIn>
      )}

      {household.role === 'owner' ? (
        <FadeSlideIn delay={260}>
          <OwnerMembership
            household={household}
            members={members}
            invites={invites}
            onChanged={markChanged}
          />
        </FadeSlideIn>
      ) : null}
    </TabScrollView>
  );
}

function chooseNextMeal(meals: PlannedMeal[], hour: number): PlannedMeal | null {
  const preferred = hour < 10 ? 'breakfast' : hour < 15 ? 'lunch' : 'dinner';
  return meals.find((meal) => meal.mealType === preferred) ?? meals[0] ?? null;
}

function HeroMeal({
  meal,
  dietStyle,
}: {
  meal: PlannedMeal;
  dietStyle: HouseholdSummary['dietStyle'];
}) {
  const image = mealImage(meal.name, meal.mealType);
  return (
    <View accessible style={today_.mealHero} accessibilityLabel={`${meal.mealType}, ${meal.name}`}>
      <View style={today_.mealHeroFrame}>
        <Image source={image.source} style={today_.mealHeroImage} resizeMode="cover" />
        <Image
          accessible={false}
          source={heroGradient}
          style={today_.mealHeroShade}
          resizeMode="stretch"
        />
        <View style={today_.mealHeroCopy}>
          <Text style={today_.editorPick}>Today&apos;s pick</Text>
          <Text style={today_.mealHeroName}>{meal.name}</Text>
          <Text style={today_.mealHeroMeta}>
            {meal.servings} servings · {dietStyle}
          </Text>
        </View>
      </View>
    </View>
  );
}

/**
 * One planned meal as a photo-led summary. The visible meal-type label keeps
 * breakfast, lunch, and dinner explicit without turning the row into a new
 * product action.
 */
function MealCard({ meal }: { meal: PlannedMeal }) {
  const image = mealImage(meal.name, meal.mealType);
  return (
    <View accessible style={today_.mealCard} accessibilityLabel={`${meal.mealType}, ${meal.name}`}>
      <Image source={image.source} style={today_.mealThumb} resizeMode="cover" />
      <View style={today_.mealCardCopy}>
        <Text style={today_.mealMeta}>{meal.mealType}</Text>
        <Text style={today_.mealName} numberOfLines={2}>
          {meal.name}
        </Text>
        <Text style={today_.mealServings}>{meal.servings} servings</Text>
      </View>
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
  const sendViaWhatsApp = useCallback(
    async (invitePhone: string, inviteToken: string, inviteRole: 'member' | 'cook') => {
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
    },
    [household.name],
  );

  const createInvite = useCallback(async () => {
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
  }, [api, household.id, onChanged, phone, role, sendViaWhatsApp]);

  const resend = useCallback(
    async (inviteId: string) => {
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
    },
    [api, onChanged, phone, sendViaWhatsApp],
  );

  const revoke = useCallback(
    async (inviteId: string) => {
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
    },
    [api, onChanged],
  );

  const remove = useCallback(
    async (membershipId: string) => {
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
    },
    [api, household.id, onChanged],
  );

  const selectCookRole = useCallback(() => setRole('cook'), []);
  const selectMemberRole = useCallback(() => setRole('member'), []);

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
            accessibilityState={
              role === 'cook' ? SELECTED_ACCESSIBILITY_STATE : UNSELECTED_ACCESSIBILITY_STATE
            }
            style={role === 'cook' ? SEGMENT_BUTTON_ACTIVE_STYLE : styles.segmentButton}
            onPress={selectCookRole}
          >
            <Text style={role === 'cook' ? SEGMENT_TEXT_ACTIVE_STYLE : styles.segmentText}>
              Cook
            </Text>
          </PressableScale>
          <PressableScale
            accessibilityRole="button"
            accessibilityLabel="Invite a member"
            accessibilityState={
              role === 'member' ? SELECTED_ACCESSIBILITY_STATE : UNSELECTED_ACCESSIBILITY_STATE
            }
            style={role === 'member' ? SEGMENT_BUTTON_ACTIVE_STYLE : styles.segmentButton}
            onPress={selectMemberRole}
          >
            <Text style={role === 'member' ? SEGMENT_TEXT_ACTIVE_STYLE : styles.segmentText}>
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
          style={busy ? DISABLED_PRIMARY_BUTTON_STYLE : styles.primaryButton}
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
            <PendingInviteRow
              key={invite.id}
              invite={invite}
              showDivider={i > 0}
              busy={busy}
              onResend={resend}
              onRevoke={revoke}
            />
          ))}
        </Card>
      ) : null}

      <Card>
        <Text style={styles.cardTitle}>Members and cooks</Text>
        {members.map((member, i) => (
          <MemberAccessRow
            key={member.id}
            member={member}
            showDivider={i > 0}
            busy={busy}
            onRemove={remove}
          />
        ))}
      </Card>
    </View>
  );
}

function PendingInviteRow({
  invite,
  showDivider,
  busy,
  onResend,
  onRevoke,
}: {
  invite: InviteSummary;
  showDivider: boolean;
  busy: boolean;
  onResend: (inviteId: string) => Promise<void>;
  onRevoke: (inviteId: string) => Promise<void>;
}) {
  const resendInvite = useCallback(() => void onResend(invite.id), [invite.id, onResend]);
  const revokeInvite = useCallback(() => void onRevoke(invite.id), [invite.id, onRevoke]);

  return (
    <View>
      {showDivider ? <Divider /> : null}
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
            onPress={resendInvite}
          >
            <Text style={styles.ghostButtonText}>Resend</Text>
          </PressableScale>
          <PressableScale
            accessibilityRole="button"
            accessibilityLabel={`Revoke invite to ${invite.phoneMasked}`}
            style={styles.ghostButton}
            disabled={busy}
            onPress={revokeInvite}
          >
            <Text style={owner.dangerAction}>Revoke</Text>
          </PressableScale>
        </View>
      </View>
    </View>
  );
}

function MemberAccessRow({
  member,
  showDivider,
  busy,
  onRemove,
}: {
  member: HouseholdMember;
  showDivider: boolean;
  busy: boolean;
  onRemove: (membershipId: string) => Promise<void>;
}) {
  const removeAccess = useCallback(() => void onRemove(member.id), [member.id, onRemove]);

  return (
    <View>
      {showDivider ? <Divider /> : null}
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
            onPress={removeAccess}
          >
            <Text style={owner.dangerAction}>Remove</Text>
          </PressableScale>
        ) : null}
      </View>
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
    paddingHorizontal: 20,
    paddingBottom: space.md,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    backgroundColor: colors.surface,
  },
  headerCopy: { flex: 1, gap: 2 },
  headerName: {
    fontFamily: fonts.display,
    fontSize: 20,
    lineHeight: 24,
    fontWeight: '600',
    color: colors.ink,
  },
  headerRole: { fontSize: 11, lineHeight: 15, color: colors.inkSoft },
});

const today_ = StyleSheet.create({
  scroll: {
    paddingHorizontal: 20,
    paddingTop: space.md,
    paddingBottom: space.xxl,
    gap: 18,
  },
  greeting: { gap: 3, paddingBottom: space.sm },
  date: {
    fontSize: 10,
    lineHeight: 13,
    color: colors.inkSoft,
    textTransform: 'uppercase',
    letterSpacing: 1.5,
    fontWeight: '700',
  },
  greetingTitle: {
    fontFamily: fonts.display,
    fontSize: 30,
    lineHeight: 36,
    fontWeight: '600',
    color: colors.ink,
  },
  greetingBody: { fontSize: 14, lineHeight: 20, color: colors.inkSoft },
  sectionTitle: {
    fontFamily: fonts.display,
    fontSize: 23,
    lineHeight: 28,
    fontWeight: '600',
    color: colors.ink,
  },
  mealHero: { position: 'relative' },
  mealHeroFrame: {
    height: 236,
    overflow: 'hidden',
    borderRadius: radius.lg,
    backgroundColor: colors.surfaceDeep,
  },
  mealHeroImage: { width: '100%', height: '100%' },
  mealHeroShade: {
    position: 'absolute',
    right: 0,
    bottom: 0,
    left: 0,
    width: '100%',
    height: '76%',
  },
  mealHeroCopy: { position: 'absolute', right: 18, bottom: 16, left: 18, gap: 6 },
  editorPick: {
    alignSelf: 'flex-start',
    paddingHorizontal: 8,
    paddingVertical: 5,
    borderRadius: 5,
    overflow: 'hidden',
    backgroundColor: colors.coral,
    color: colors.card,
    fontSize: 11,
    lineHeight: 13,
    fontWeight: '900',
    textTransform: 'uppercase',
    letterSpacing: 1.1,
  },
  mealHeroName: {
    fontFamily: fonts.display,
    fontSize: 25,
    lineHeight: 30,
    fontWeight: '600',
    color: colors.card,
    letterSpacing: -0.4,
    textShadowColor: HERO_TEXT_SHADOW,
    textShadowOffset: { width: 0, height: 2 },
    textShadowRadius: 6,
  },
  mealHeroMeta: {
    fontSize: 12,
    color: HERO_TEXT_SOFT,
    textTransform: 'capitalize',
    textShadowColor: HERO_TEXT_SHADOW,
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 4,
  },
  mealCard: {
    minHeight: 112,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.lg,
    paddingVertical: space.sm,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  mealThumb: {
    width: 112,
    height: 96,
    borderRadius: radius.md,
    backgroundColor: colors.surfaceDeep,
  },
  mealCardCopy: { flex: 1, gap: 4 },
  mealName: {
    fontFamily: fonts.display,
    fontSize: 19,
    lineHeight: 24,
    fontWeight: '600',
    color: colors.ink,
  },
  mealMeta: {
    fontSize: 10,
    lineHeight: 13,
    fontWeight: '800',
    letterSpacing: 1.1,
    color: colors.brand,
    textTransform: 'uppercase',
  },
  mealServings: { fontSize: 12, lineHeight: 16, color: colors.inkSoft },
  sectionHead: { gap: 3, marginTop: space.sm },
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
  dangerAction: { color: colors.danger, fontSize: 15, fontWeight: '700' },
});

const SEGMENT_BUTTON_ACTIVE_STYLE = [styles.segmentButton, styles.segmentActive];
const SEGMENT_TEXT_ACTIVE_STYLE = [styles.segmentText, styles.segmentTextActive];
const DISABLED_PRIMARY_BUTTON_STYLE = [styles.primaryButton, styles.disabled];
