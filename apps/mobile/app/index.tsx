import { useState, useEffect } from 'react';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { useSignIn, useSignUp, useUser } from '@clerk/clerk-expo';
import { useApi } from '../src/lib/api';
import { useHouseholds } from '../src/lib/households';
import { colors } from '../src/components/ui';
import { MemberShell } from '../src/screens/MemberShell';
import { CookShell } from '../src/screens/CookShell';

/**
 * Cooklink entry (issue 03 — role-aware navigation).
 *
 * After phone-OTP sign-in we resolve the person's memberships and choose the
 * entry shell: a Member or Owner lands on their active Household's Today; a
 * Cook lands on the Household list. Someone with both kinds of membership keeps
 * the last area (My home / Work) and can switch between them.
 *
 * If the person arrived from a `cooklink://invite?token=...` deep link while
 * signed out, the invite token is carried as `pending_invite_token` through
 * the OTP flow. Once sign-in completes, this route redirects to `/invite` with
 * the token so the recipient can accept without re-tapping the WhatsApp link.
 */
export default function Home() {
  const { isLoaded, isSignedIn, user } = useUser();
  const router = useRouter();
  const params = useLocalSearchParams<{ pending_invite_token?: string }>();

  // After OTP completes, carry the preserved invite token back to /invite so
  // the recipient can accept in one continuous flow.
  useEffect(() => {
    if (isSignedIn && params.pending_invite_token) {
      router.replace(`/invite?token=${encodeURIComponent(params.pending_invite_token)}`);
    }
  }, [isSignedIn, params.pending_invite_token, router]);

  if (!isLoaded) return <Loading />;
  if (!isSignedIn || !user) return <PhoneOtp />;
  // While the redirect effect runs, show a loader instead of briefly
  // rendering HouseholdApp with a stale pending token.
  if (params.pending_invite_token) return <Loading />;
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
  const {
    households,
    error,
    loadHouseholds,
    area,
    chooseArea,
    homeHouseholds,
    workHouseholds,
    selected,
    chooseHousehold,
  } = useHouseholds();
  const router = useRouter();
  const [onboarding, setOnboarding] = useState(false);

  // A profile_required error means the person has no Clerk user row yet; the
  // server creates it lazily. A no-households state offers the owner onboarding
  // path AND the invite-acceptance path (issue 03 — a Member or Cook lands here
  // with zero households until they accept their WhatsApp invite).
  if (error?.includes('profile_required')) return <OwnerOnboarding onCreated={loadHouseholds} />;
  if (error) return <Message title="Could not load Cooklink" body={error} />;
  if (!households) return <Loading />;
  if (households.length === 0) {
    return onboarding ? (
      <OwnerOnboarding onCreated={loadHouseholds} onCancel={() => setOnboarding(false)} />
    ) : (
      <NoHouseholds
        onStart={() => setOnboarding(true)}
        onAcceptInvite={() => router.push('/invite')}
      />
    );
  }

  const hasBoth = homeHouseholds.length > 0 && workHouseholds.length > 0;

  // No Member/Owner household and at least one Cook Household: Cook only.
  if (homeHouseholds.length === 0) {
    return (
      <>
        <CookShell households={workHouseholds} onSelectHousehold={chooseHousehold} />
      </>
    );
  }

  return (
    <View style={{ flex: 1 }}>
      {hasBoth ? (
        <AreaSwitcher
          area={area}
          onChange={chooseArea}
          homeCount={homeHouseholds.length}
          workCount={workHouseholds.length}
        />
      ) : null}
      {area === 'work' ? (
        <CookShell households={workHouseholds} onSelectHousehold={chooseHousehold} />
      ) : selected ? (
        <MemberShell key={selected.id} household={selected} />
      ) : (
        <Loading />
      )}
    </View>
  );
}

/**
 * The My home / Work switcher for a person with both kinds of membership
 * (issue 03 — move between areas, app remembers the last one). Pure UI; the
 * remembered choice is persisted in `useHouseholds`.
 */
function AreaSwitcher({
  area,
  onChange,
  homeCount,
  workCount,
}: {
  area: 'home' | 'work';
  onChange: (next: 'home' | 'work') => void;
  homeCount: number;
  workCount: number;
}) {
  return (
    <View style={areaStyles.bar}>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ selected: area === 'home' }}
        style={[areaStyles.tab, area === 'home' && areaStyles.tabActive]}
        onPress={() => onChange('home')}
      >
        <Text style={areaStyles.label}>My home</Text>
        <Text style={areaStyles.count}>{homeCount}</Text>
      </Pressable>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ selected: area === 'work' }}
        style={[areaStyles.tab, area === 'work' && areaStyles.tabActive]}
        onPress={() => onChange('work')}
      >
        <Text style={areaStyles.label}>Work</Text>
        <Text style={areaStyles.count}>{workCount}</Text>
      </Pressable>
    </View>
  );
}

function OwnerOnboarding({
  onCreated,
  onCancel,
}: {
  onCreated: () => Promise<unknown>;
  onCancel?: () => void;
}) {
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
        accessibilityRole="button"
        accessibilityLabel="Create active meal plan"
        style={[styles.primaryButton, busy && styles.disabled]}
        disabled={busy}
        onPress={createHousehold}
      >
        <Text style={styles.primaryButtonText}>
          {busy ? 'Starting plan' : 'Create active meal plan'}
        </Text>
      </Pressable>
      {onCancel ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Back to join choices"
          style={styles.ghostButton}
          onPress={onCancel}
        >
          <Text style={styles.ghostButtonText}>Back</Text>
        </Pressable>
      ) : null}
    </ScrollView>
  );
}

/**
 * The zero-households entry choice (issue 03). A person who just verified their
 * phone either starts their own household as an Owner or accepts a WhatsApp
 * invite to join someone else's as a Member or Cook. Both paths are offered so
 * a Cook with no households is never forced into owner onboarding.
 */
function NoHouseholds({
  onStart,
  onAcceptInvite,
}: {
  onStart: () => void;
  onAcceptInvite: () => void;
}) {
  return (
    <ScrollView contentContainerStyle={styles.screen}>
      <Text style={styles.eyebrow}>Welcome</Text>
      <Text style={styles.title}>Join Cooklink</Text>
      <Text style={styles.subtitle}>
        Start your own household, or accept an invite from someone who invited you.
      </Text>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Start a household"
        style={styles.primaryButton}
        onPress={onStart}
      >
        <Text style={styles.primaryButtonText}>Start a household</Text>
      </Pressable>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Accept an invite"
        style={styles.ghostButton}
        onPress={onAcceptInvite}
      >
        <Text style={styles.ghostButtonText}>I have an invite</Text>
      </Pressable>
    </ScrollView>
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
  screen: { flexGrow: 1, padding: 24, paddingTop: 56, backgroundColor: colors.surface, gap: 16 },
  centerScreen: {
    flex: 1,
    padding: 24,
    justifyContent: 'center',
    backgroundColor: colors.surface,
    gap: 16,
  },
  eyebrow: { fontSize: 13, fontWeight: '700', color: colors.brand, textTransform: 'uppercase' },
  title: { fontSize: 34, fontWeight: '700', color: colors.ink },
  sectionTitle: { fontSize: 18, fontWeight: '700', color: colors.ink, marginTop: 8 },
  subtitle: { fontSize: 16, lineHeight: 22, color: colors.inkSoft },
  input: {
    borderWidth: 1,
    borderColor: '#c8d0c8',
    borderRadius: 8,
    padding: 14,
    fontSize: 18,
    backgroundColor: '#fff',
  },
  primaryButton: {
    borderRadius: 8,
    padding: 16,
    backgroundColor: colors.accent,
    alignItems: 'center',
  },
  primaryButtonText: { color: '#fff', fontSize: 17, fontWeight: '700' },
  ghostButton: {
    borderRadius: 8,
    padding: 14,
    backgroundColor: colors.field,
    alignItems: 'center',
  },
  ghostButtonText: { color: colors.ink, fontSize: 16, fontWeight: '700' },
  disabled: { opacity: 0.7 },
  segment: { flexDirection: 'row', gap: 8 },
  segmentButton: {
    flex: 1,
    borderRadius: 8,
    padding: 12,
    alignItems: 'center',
    backgroundColor: colors.field,
  },
  segmentActive: { backgroundColor: colors.accentSoft },
  segmentText: { color: colors.ink, fontWeight: '700' },
  error: { color: colors.danger },
});

const areaStyles = StyleSheet.create({
  bar: {
    flexDirection: 'row',
    backgroundColor: colors.card,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  tab: {
    flex: 1,
    paddingVertical: 14,
    alignItems: 'center',
    gap: 2,
    minHeight: 56,
  },
  tabActive: {
    borderBottomWidth: 3,
    borderBottomColor: colors.accent,
  },
  label: { fontSize: 15, fontWeight: '700', color: colors.ink },
  count: { fontSize: 12, color: colors.inkSoft },
});
