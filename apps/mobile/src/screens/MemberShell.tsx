import { useEffect, useState } from 'react';
import { Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import { useApi } from '../lib/api';
import {
  useAccessProbe,
  type HouseholdMember,
  type HouseholdSummary,
  type InviteSummary,
  type PlannedMeal,
} from '../lib/households';
import {
  BottomTabs,
  Card,
  ChatHeaderAction,
  Loading,
  Message,
  styles,
  type TabKey,
  type TabSpec,
} from '../components/ui';
import { MealPlanScreen } from './MealPlan';
import { GroceriesScreen } from './Groceries';
import { ChatScreen } from './Chat';

const MEMBER_TABS: readonly TabSpec[] = [
  { key: 'today', label: 'Today', glyph: '◐' },
  { key: 'mealPlan', label: 'Meal Plan', glyph: '◳' },
  { key: 'groceries', label: 'Groceries', glyph: '▦' },
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
    return (
      <ChatScreen
        household={household}
        backLabel="Back"
        onBack={() => setChatOpen(false)}
      />
    );
  }

  return (
    <View style={{ flex: 1 }}>
      <View style={headerStyles.header}>
        <Text style={headerStyles.name} numberOfLines={1}>
          {household.name}
        </Text>
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
  );
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

  const today = new Date().toISOString().slice(0, 10);
  const todayMeals = (meals ?? []).filter((m) => m.date === today);

  return (
    <ScrollView contentContainerStyle={{ ...styles.screen, paddingTop: 16 }}>
      <Text style={styles.eyebrow}>Today</Text>
      <Card>
        <Text style={styles.cardTitle}>Today's meals</Text>
        {meals ? (
          todayMeals.length > 0 ? (
            todayMeals.map((meal) => (
              <View key={meal.id} style={styles.mealRow}>
                <Text style={styles.mealType}>{meal.mealType}</Text>
                <Text style={styles.mealName}>
                  {meal.name}
                  {meal.isSpecial ? ' · special' : ''}
                </Text>
              </View>
            ))
          ) : (
            <Text style={styles.subtitle}>No meals planned for today.</Text>
          )
        ) : (
          <Loading />
        )}
      </Card>
      {household.role === 'owner' ? (
        <OwnerMembership
          household={household}
          members={members}
          invites={invites}
          onChanged={() => setChanged((n) => n + 1)}
        />
      ) : null}
    </ScrollView>
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

  async function createInvite() {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const result = await api<{ token: string }>(`/v1/households/${household.id}/invites`, {
        method: 'POST',
        body: JSON.stringify({ phone, role }),
      });
      setNotice(`Invite created. Share this token with the ${role}: ${result.token}`);
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
    try {
      const result = await api<{ token: string }>(`/v1/invites/${inviteId}/resend`, {
        method: 'POST',
      });
      setNotice(`Resent. New token: ${result.token}`);
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
    <Card>
      <Text style={styles.cardTitle}>Invite people</Text>
      <View style={styles.segment}>
        <Pressable
          accessibilityRole="button"
          style={[styles.segmentButton, role === 'cook' && styles.segmentActive]}
          onPress={() => setRole('cook')}
        >
          <Text style={styles.segmentText}>Cook</Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          style={[styles.segmentButton, role === 'member' && styles.segmentActive]}
          onPress={() => setRole('member')}
        >
          <Text style={styles.segmentText}>Member</Text>
        </Pressable>
      </View>
      <Text style={styles.subtitle}>Send a WhatsApp invite to this phone number.</Text>
      <InvitePhoneInput value={phone} onChange={setPhoneState} />
      <Pressable
        accessibilityRole="button"
        style={[styles.primaryButton, busy && styles.disabled]}
        disabled={busy}
        onPress={createInvite}
      >
        <Text style={styles.primaryButtonText}>Create {role} invite</Text>
      </Pressable>
      {error ? <Text style={styles.error}>{error}</Text> : null}
      {notice ? <Text style={styles.subtitle}>{notice}</Text> : null}

      {invites.length > 0 ? (
        <>
          <Text style={styles.sectionTitle}>Pending invites</Text>
          {invites.map((invite) => (
            <View key={invite.id} style={inviteStyles.row}>
              <Text style={styles.listItem}>
                {invite.role} · {invite.phoneMasked}
              </Text>
              <View style={inviteStyles.actions}>
                <Pressable
                  accessibilityRole="button"
                  style={styles.ghostButton}
                  disabled={busy}
                  onPress={() => resend(invite.id)}
                >
                  <Text style={styles.ghostButtonText}>Resend</Text>
                </Pressable>
                <Pressable
                  accessibilityRole="button"
                  style={styles.ghostButton}
                  disabled={busy}
                  onPress={() => revoke(invite.id)}
                >
                  <Text style={styles.ghostButtonText}>Revoke</Text>
                </Pressable>
              </View>
            </View>
          ))}
        </>
      ) : null}

      <Text style={styles.sectionTitle}>Household members</Text>
      {members.map((member) => (
        <View key={member.id} style={inviteStyles.row}>
          <Text style={styles.listItem}>
            {member.role} · {member.notificationDefault}
          </Text>
          {member.role !== 'owner' ? (
            <Pressable
              accessibilityRole="button"
              style={styles.ghostButton}
              disabled={busy}
              onPress={() => remove(member.id)}
            >
              <Text style={styles.ghostButtonText}>Remove</Text>
            </Pressable>
          ) : (
            <Text style={styles.listItem}>owner</Text>
          )}
        </View>
      ))}
    </Card>
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
      keyboardType="phone-pad"
    />
  );
}

const headerStyles = {
  header: {
    flexDirection: 'row' as const,
    alignItems: 'center' as const,
    justifyContent: 'space-between' as const,
    paddingHorizontal: 24,
    paddingTop: 56,
    paddingBottom: 12,
    backgroundColor: '#f7f3ed',
  },
  name: { fontSize: 20, fontWeight: '700' as const, color: '#24352f', flex: 1, marginRight: 12 },
};

const inviteStyles = {
  row: { flexDirection: 'row' as const, alignItems: 'center' as const, justifyContent: 'space-between' as const, gap: 8 },
  actions: { flexDirection: 'row' as const, gap: 8 },
};
