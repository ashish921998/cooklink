import { useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useSignIn, useSignUp, useUser } from '@clerk/clerk-expo';
import { useApi } from '../src/lib/api';

type Role = 'owner' | 'member' | 'cook';
type MealType = 'breakfast' | 'lunch' | 'dinner';

type HouseholdSummary = {
  id: string;
  name: string;
  role: Role;
  servingCount: number;
  mealStyle: string;
  dietStyle: string;
};

type PlannedMeal = {
  id: string;
  date: string;
  mealType: MealType;
  name: string;
  servings: number;
  isSpecial: boolean;
};

type HouseholdMember = {
  id: string;
  role: Role;
  status: string;
  notificationDefault: string;
};

export default function Home() {
  const { isLoaded, isSignedIn, user } = useUser();
  if (!isLoaded) return <Loading />;
  if (!isSignedIn || !user) return <PhoneOtp />;
  return <HouseholdApp />;
}

function PhoneOtp() {
  const signIn = useSignIn();
  const signUp = useSignUp();
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [pending, setPending] = useState(false);
  const [mode, setMode] = useState<'signIn' | 'signUp'>('signIn');
  const [error, setError] = useState<string | null>(null);

  async function startOtp() {
    setError(null);
    try {
      if (mode === 'signIn') {
        const attempt = await signIn.signIn?.create({ identifier: phone });
        const phoneFactor = attempt?.supportedFirstFactors?.find(
          (factor) => factor.strategy === 'phone_code',
        );
        if (!phoneFactor || !('phoneNumberId' in phoneFactor))
          throw new Error('Phone OTP is not enabled for this account.');
        await signIn.signIn?.prepareFirstFactor({
          strategy: 'phone_code',
          phoneNumberId: phoneFactor.phoneNumberId,
        });
      } else {
        await signUp.signUp?.create({ phoneNumber: phone });
        await signUp.signUp?.preparePhoneNumberVerification({ strategy: 'phone_code' });
      }
      setPending(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not send the code.');
    }
  }

  async function verifyOtp() {
    setError(null);
    try {
      if (mode === 'signIn') {
        const result = await signIn.signIn?.attemptFirstFactor({ strategy: 'phone_code', code });
        if (result?.status === 'complete')
          await signIn.setActive?.({ session: result.createdSessionId });
      } else {
        const result = await signUp.signUp?.attemptPhoneNumberVerification({ code });
        if (result?.status === 'complete')
          await signUp.setActive?.({ session: result.createdSessionId });
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The code was not accepted.');
    }
  }

  return (
    <View style={styles.centerScreen}>
      <Text style={styles.title}>Cooklink</Text>
      <Text style={styles.subtitle}>
        Sign in with the phone number tied to your household invite.
      </Text>
      <View style={styles.segment}>
        <Pressable
          style={[styles.segmentButton, mode === 'signIn' && styles.segmentActive]}
          onPress={() => setMode('signIn')}
        >
          <Text style={styles.segmentText}>Sign in</Text>
        </Pressable>
        <Pressable
          style={[styles.segmentButton, mode === 'signUp' && styles.segmentActive]}
          onPress={() => setMode('signUp')}
        >
          <Text style={styles.segmentText}>Create account</Text>
        </Pressable>
      </View>
      <TextInput
        style={styles.input}
        placeholder="+91 phone number"
        keyboardType="phone-pad"
        value={phone}
        onChangeText={setPhone}
      />
      {pending ? (
        <TextInput
          style={styles.input}
          placeholder="OTP code"
          keyboardType="number-pad"
          value={code}
          onChangeText={setCode}
        />
      ) : null}
      {error ? <Text style={styles.error}>{error}</Text> : null}
      <Pressable style={styles.primaryButton} onPress={pending ? verifyOtp : startOtp}>
        <Text style={styles.primaryButtonText}>{pending ? 'Verify code' : 'Send code'}</Text>
      </Pressable>
    </View>
  );
}

function HouseholdApp() {
  const api = useApi();
  const [households, setHouseholds] = useState<HouseholdSummary[] | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [cookHouseholdOpen, setCookHouseholdOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function loadHouseholds() {
    const data = await api<{ households: HouseholdSummary[] }>('/v1/households');
    setHouseholds(data.households);
    setSelectedId((current) => current ?? data.households[0]?.id ?? null);
  }

  useEffect(() => {
    loadHouseholds().catch((err) =>
      setError(err instanceof Error ? err.message : 'Could not load households.'),
    );
  }, [api]);

  if (error?.includes('profile_required')) return <OwnerOnboarding onCreated={loadHouseholds} />;
  if (error) return <Message title="Could not load Cooklink" body={error} />;
  if (!households) return <Loading />;
  if (households.length === 0) return <OwnerOnboarding onCreated={loadHouseholds} />;

  const firstCookHousehold = households.find((household) => household.role === 'cook');
  const selected = households.find((household) => household.id === selectedId) ?? households.at(0);
  if (!selected) return <OwnerOnboarding onCreated={loadHouseholds} />;
  if (firstCookHousehold && households.every((household) => household.role === 'cook')) {
    if (cookHouseholdOpen) {
      return (
        <TodayScreen
          household={selected}
          onRefresh={loadHouseholds}
          onBack={() => setCookHouseholdOpen(false)}
        />
      );
    }
    return (
      <CookHouseholdList
        households={households}
        selectedId={selectedId}
        onSelect={(householdId) => {
          setSelectedId(householdId);
          setCookHouseholdOpen(true);
        }}
      />
    );
  }
  return <TodayScreen household={selected} onRefresh={loadHouseholds} />;
}

function OwnerOnboarding({ onCreated }: { onCreated: () => Promise<void> }) {
  const api = useApi();
  const [name, setName] = useState('My Home');
  const [servingCount, setServingCount] = useState('4');
  const [mealStyle, setMealStyle] = useState<'north' | 'south'>('north');
  const [dietStyle, setDietStyle] = useState<'vegetarian' | 'eggetarian' | 'nonvegetarian'>(
    'vegetarian',
  );
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function createHousehold() {
    setBusy(true);
    setMessage('Building your first seven-day meal plan...');
    const startedAt = Date.now();
    try {
      const result = await api<{ householdId: string; mealCount: number }>('/v1/households', {
        method: 'POST',
        body: JSON.stringify({
          name,
          servingCount: Number(servingCount),
          mealStyle,
          dietStyle,
        }),
      });
      const elapsed = Math.round((Date.now() - startedAt) / 1000);
      setMessage(`${result.mealCount} meals active in ${elapsed}s.`);
      await onCreated();
    } catch (err) {
      setMessage(err instanceof Error ? err.message : 'Could not create your household.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <ScrollView contentContainerStyle={styles.screen}>
      <Text style={styles.eyebrow}>Owner setup</Text>
      <Text style={styles.title}>Start your household</Text>
      <TextInput
        style={styles.input}
        value={name}
        onChangeText={setName}
        placeholder="Household name"
      />
      <TextInput
        style={styles.input}
        value={servingCount}
        onChangeText={setServingCount}
        placeholder="Servings"
        keyboardType="number-pad"
      />
      <View style={styles.segment}>
        <Pressable
          style={[styles.segmentButton, mealStyle === 'north' && styles.segmentActive]}
          onPress={() => setMealStyle('north')}
        >
          <Text style={styles.segmentText}>North Indian</Text>
        </Pressable>
        <Pressable
          style={[styles.segmentButton, mealStyle === 'south' && styles.segmentActive]}
          onPress={() => setMealStyle('south')}
        >
          <Text style={styles.segmentText}>South Indian</Text>
        </Pressable>
      </View>
      <Text style={styles.sectionTitle}>Food preference</Text>
      <View style={styles.segment}>
        {(
          [
            ['vegetarian', 'Veg'],
            ['eggetarian', 'Egg'],
            ['nonvegetarian', 'Non-veg'],
          ] as const
        ).map(([value, label]) => (
          <Pressable
            key={value}
            style={[styles.segmentButton, dietStyle === value && styles.segmentActive]}
            onPress={() => setDietStyle(value)}
          >
            <Text style={styles.segmentText}>{label}</Text>
          </Pressable>
        ))}
      </View>
      {message ? <Text style={styles.subtitle}>{message}</Text> : null}
      <Pressable
        style={[styles.primaryButton, busy && styles.disabled]}
        disabled={busy}
        onPress={createHousehold}
      >
        <Text style={styles.primaryButtonText}>
          {busy ? 'Starting plan' : 'Create active meal plan'}
        </Text>
      </Pressable>
    </ScrollView>
  );
}

function TodayScreen({
  household,
  onRefresh,
  onBack,
}: {
  household: HouseholdSummary;
  onRefresh: () => Promise<void>;
  onBack?: () => void;
}) {
  const api = useApi();
  const [meals, setMeals] = useState<PlannedMeal[] | null>(null);
  const [members, setMembers] = useState<HouseholdMember[]>([]);
  const [view, setView] = useState<'today' | 'week'>('today');

  useEffect(() => {
    setMeals(null);
    api<{ meals: PlannedMeal[] }>(`/v1/households/${household.id}/meal-plan`).then((data) =>
      setMeals(data.meals),
    );
    if (household.role === 'owner') {
      api<{ members: HouseholdMember[] }>(`/v1/households/${household.id}/members`).then((data) =>
        setMembers(data.members),
      );
    }
  }, [api, household.id, household.role]);

  const today = useMemo(() => new Date().toISOString().slice(0, 10), []);
  const todayMeals = meals?.filter((meal) => meal.date === today) ?? [];
  const weekDays = [...new Set((meals ?? []).map((meal) => meal.date))];

  return (
    <ScrollView contentContainerStyle={styles.screen}>
      {onBack ? (
        <Pressable onPress={onBack} accessibilityRole="button">
          <Text style={styles.backLink}>‹ Households</Text>
        </Pressable>
      ) : null}
      <Text style={styles.eyebrow}>
        {household.role === 'owner' ? 'Owner Today' : 'Member Today'}
      </Text>
      <Text style={styles.title}>{household.name}</Text>
      <View style={styles.segment}>
        <Pressable
          style={[styles.segmentButton, view === 'today' && styles.segmentActive]}
          onPress={() => setView('today')}
        >
          <Text style={styles.segmentText}>Today</Text>
        </Pressable>
        <Pressable
          style={[styles.segmentButton, view === 'week' && styles.segmentActive]}
          onPress={() => setView('week')}
        >
          <Text style={styles.segmentText}>Weekly Meal Plan</Text>
        </Pressable>
      </View>
      <View style={styles.card}>
        <Text style={styles.cardTitle}>
          {view === 'today' ? 'Today meals' : 'Weekly Meal Plan'}
        </Text>
        {meals ? (
          view === 'today' ? (
            todayMeals.map((meal) => <MealRow key={meal.id} meal={meal} />)
          ) : (
            weekDays.map((day) => (
              <View key={day} style={styles.dayGroup}>
                <Text style={styles.sectionTitle}>{day === today ? 'Today' : day}</Text>
                {meals
                  .filter((meal) => meal.date === day)
                  .map((meal) => (
                    <MealRow key={meal.id} meal={meal} />
                  ))}
              </View>
            ))
          )
        ) : (
          <ActivityIndicator />
        )}
      </View>
      {household.role === 'owner' ? (
        <OwnerTools household={household} members={members} onRefresh={onRefresh} />
      ) : null}
    </ScrollView>
  );
}

function OwnerTools({
  household,
  members,
  onRefresh,
}: {
  household: HouseholdSummary;
  members: HouseholdMember[];
  onRefresh: () => Promise<void>;
}) {
  const api = useApi();
  const [phone, setPhone] = useState('');
  const [invite, setInvite] = useState<string | null>(null);

  async function inviteCook() {
    const result = await api<{ token: string; expiresAt: string }>(
      `/v1/households/${household.id}/invites`,
      {
        method: 'POST',
        body: JSON.stringify({ phone, role: 'cook' }),
      },
    );
    setInvite(result.token);
    setPhone('');
    await onRefresh();
  }

  return (
    <View style={styles.card}>
      <Text style={styles.cardTitle}>Cook invite</Text>
      <TextInput
        style={styles.input}
        value={phone}
        onChangeText={setPhone}
        placeholder="+91 cook phone"
        keyboardType="phone-pad"
      />
      <Pressable style={styles.secondaryButton} onPress={inviteCook}>
        <Text style={styles.secondaryButtonText}>Create cook invite</Text>
      </Pressable>
      {invite ? <Text style={styles.subtitle}>Invite token: {invite}</Text> : null}
      <Text style={styles.sectionTitle}>Household list</Text>
      {members.map((member) => (
        <Text key={member.id} style={styles.listItem}>
          {member.role} · {member.notificationDefault}
        </Text>
      ))}
    </View>
  );
}

function CookHouseholdList({
  households,
  selectedId,
  onSelect,
}: {
  households: HouseholdSummary[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  return (
    <ScrollView contentContainerStyle={styles.screen}>
      <Text style={styles.eyebrow}>Cook</Text>
      <Text style={styles.title}>Households</Text>
      {households.map((household) => (
        <Pressable
          key={household.id}
          style={[styles.card, selectedId === household.id && styles.selectedCard]}
          onPress={() => onSelect(household.id)}
        >
          <Text style={styles.cardTitle}>{household.name}</Text>
          <Text style={styles.subtitle}>Chat first · Meal Plan · Groceries</Text>
        </Pressable>
      ))}
    </ScrollView>
  );
}

function MealRow({ meal }: { meal: PlannedMeal }) {
  return (
    <View style={styles.mealRow}>
      <Text style={styles.mealType}>{meal.mealType}</Text>
      <Text style={styles.mealName}>
        {meal.name}
        {meal.isSpecial ? ' · special' : ''}
      </Text>
    </View>
  );
}

function Loading() {
  return (
    <View style={styles.centerScreen}>
      <ActivityIndicator />
    </View>
  );
}

function Message({ title, body }: { title: string; body: string }) {
  return (
    <View style={styles.centerScreen}>
      <Text style={styles.title}>{title}</Text>
      <Text style={styles.subtitle}>{body}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flexGrow: 1, padding: 24, paddingTop: 56, backgroundColor: '#f7f3ed', gap: 16 },
  centerScreen: {
    flex: 1,
    padding: 24,
    justifyContent: 'center',
    backgroundColor: '#f7f3ed',
    gap: 16,
  },
  eyebrow: { fontSize: 13, fontWeight: '700', color: '#6f4f2d', textTransform: 'uppercase' },
  title: { fontSize: 34, fontWeight: '700', color: '#24352f' },
  sectionTitle: { fontSize: 18, fontWeight: '700', color: '#24352f', marginTop: 8 },
  subtitle: { fontSize: 16, lineHeight: 22, color: '#52625d' },
  input: {
    borderWidth: 1,
    borderColor: '#c8d0c8',
    borderRadius: 8,
    padding: 14,
    fontSize: 18,
    backgroundColor: '#fff',
  },
  primaryButton: { borderRadius: 8, padding: 16, backgroundColor: '#136f63', alignItems: 'center' },
  primaryButtonText: { color: '#fff', fontSize: 17, fontWeight: '700' },
  secondaryButton: {
    borderRadius: 8,
    padding: 14,
    backgroundColor: '#24352f',
    alignItems: 'center',
  },
  secondaryButtonText: { color: '#fff', fontSize: 16, fontWeight: '700' },
  optionalButton: { borderRadius: 8, padding: 14, backgroundColor: '#e5e9e4' },
  backLink: { color: '#136f63', fontSize: 17, fontWeight: '700' },
  disabled: { opacity: 0.7 },
  segment: { flexDirection: 'row', gap: 8 },
  segmentButton: {
    flex: 1,
    borderRadius: 8,
    padding: 12,
    alignItems: 'center',
    backgroundColor: '#e5e9e4',
  },
  segmentActive: { backgroundColor: '#c9ded7' },
  segmentText: { color: '#24352f', fontWeight: '700' },
  error: { color: '#a33a2a' },
  card: {
    borderRadius: 8,
    backgroundColor: '#fff',
    padding: 16,
    borderWidth: 1,
    borderColor: '#dfe5df',
    gap: 10,
  },
  selectedCard: { borderColor: '#136f63', backgroundColor: '#eff7f4' },
  cardTitle: { fontSize: 20, fontWeight: '700', color: '#24352f' },
  listItem: { fontSize: 16, color: '#52625d', paddingVertical: 4 },
  mealRow: { flexDirection: 'row', gap: 12, alignItems: 'center', paddingVertical: 4 },
  dayGroup: { gap: 8, paddingVertical: 6 },
  mealType: {
    width: 86,
    fontSize: 13,
    color: '#6f4f2d',
    textTransform: 'uppercase',
    fontWeight: '700',
  },
  mealName: { flex: 1, fontSize: 17, color: '#24352f' },
});
