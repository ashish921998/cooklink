import { useState, useEffect } from 'react';
import { ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { useSignIn, useSignUp, useUser } from '@clerk/expo';
import { devAuthEnabled, useApi } from '../src/lib/api';
import { useHouseholds } from '../src/lib/households';
import {
  Card,
  Chip,
  ErrorNote,
  FadeSlideIn,
  Field,
  Loading,
  Message,
  PressableScale,
  colors,
  fonts,
  radius,
  shadow,
  space,
  styles,
} from '../src/components/ui';
import { BrandLogo } from '../src/components/BrandLogo';
import { Mascot, MascotState } from '../src/components/Mascot';
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
    if ((isSignedIn || devAuthEnabled) && params.pending_invite_token) {
      router.replace(`/invite?token=${encodeURIComponent(params.pending_invite_token)}`);
    }
  }, [isSignedIn, params.pending_invite_token, router]);

  if (devAuthEnabled) {
    if (params.pending_invite_token) return <Loading />;
    return <HouseholdApp />;
  }
  if (!isLoaded) return <Loading />;
  if (!isSignedIn || !user) return <PhoneOtp />;
  // While the redirect effect runs, show a loader instead of briefly
  // rendering HouseholdApp with a stale pending token.
  if (params.pending_invite_token) return <Loading />;
  return <HouseholdApp />;
}

function PhoneOtp() {
  const { signIn, fetchStatus: signInStatus } = useSignIn();
  const { signUp, fetchStatus: signUpStatus } = useSignUp();
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [pending, setPending] = useState(false);
  const [mode, setMode] = useState<'signIn' | 'signUp'>('signIn');
  const [error, setError] = useState<string | null>(null);
  const isFetching = signInStatus === 'fetching' || signUpStatus === 'fetching';

  async function startOtp() {
    setError(null);
    try {
      if (mode === 'signIn') {
        const { error: sendError } = await signIn.phoneCode.sendCode({ phoneNumber: phone });
        if (sendError) throw sendError;
      } else {
        const { error: createError } = await signUp.create({ phoneNumber: phone });
        if (createError) throw createError;
        const { error: sendError } = await signUp.verifications.sendPhoneCode();
        if (sendError) throw sendError;
      }
      setPending(true);
    } catch (err) {
      setError(readableAuthError(err, 'Could not send the code.'));
    }
  }

  async function verifyOtp() {
    setError(null);
    try {
      if (mode === 'signIn') {
        const { error: verifyError } = await signIn.phoneCode.verifyCode({ code });
        if (verifyError) throw verifyError;
        if (signIn.status === 'complete') {
          const { error: finalizeError } = await signIn.finalize();
          if (finalizeError) throw finalizeError;
        }
      } else {
        const { error: verifyError } = await signUp.verifications.verifyPhoneCode({ code });
        if (verifyError) throw verifyError;
        if (signUp.status === 'complete') {
          const { error: finalizeError } = await signUp.finalize();
          if (finalizeError) throw finalizeError;
        }
      }
    } catch (err) {
      setError(readableAuthError(err, 'The code was not accepted.'));
    }
  }

  function switchMode(next: 'signIn' | 'signUp') {
    setMode(next);
    setPending(false);
    setCode('');
    setError(null);
    if (next === 'signIn') void signUp.reset();
    else void signIn.reset();
  }

  return (
    <ScrollView
      contentContainerStyle={auth.scroll}
      keyboardShouldPersistTaps="handled"
      showsVerticalScrollIndicator={false}
    >
      {/* Chotu greets first — the app has a face before it asks for a phone number. */}
      <FadeSlideIn>
        <View style={auth.hero}>
          <Mascot size={162} say="Namaste!" />
        </View>
      </FadeSlideIn>

      <FadeSlideIn delay={110}>
        <View style={auth.intro}>
          <BrandLogo />
          <Text style={auth.tagline}>
            One kitchen, one plan. Shared by your household and your cook.
          </Text>
        </View>
      </FadeSlideIn>

      <FadeSlideIn delay={190}>
        <Card style={auth.card}>
          <View style={styles.segment}>
            <PressableScale
              accessibilityRole="button"
              accessibilityLabel="Sign in"
              accessibilityState={{ selected: mode === 'signIn' }}
              style={[styles.segmentButton, mode === 'signIn' && styles.segmentActive]}
              disabled={isFetching}
              onPress={() => switchMode('signIn')}
            >
              <Text style={[styles.segmentText, mode === 'signIn' && styles.segmentTextActive]}>
                Sign in
              </Text>
            </PressableScale>
            <PressableScale
              accessibilityRole="button"
              accessibilityLabel="Create account"
              accessibilityState={{ selected: mode === 'signUp' }}
              style={[styles.segmentButton, mode === 'signUp' && styles.segmentActive]}
              disabled={isFetching}
              onPress={() => switchMode('signUp')}
            >
              <Text style={[styles.segmentText, mode === 'signUp' && styles.segmentTextActive]}>
                Create account
              </Text>
            </PressableScale>
          </View>

          <Field
            label="Phone number"
            hint={pending ? undefined : 'Use the number your household invite was sent to.'}
          >
            <TextInput
              accessibilityLabel="Phone number"
              style={styles.input}
              placeholder="+91 00000 00000"
              placeholderTextColor={colors.inkSoft}
              keyboardType="phone-pad"
              value={phone}
              onChangeText={setPhone}
            />
          </Field>

          {pending ? (
            <FadeSlideIn from={10}>
              <Field label="Verification code" hint="We sent a six-digit code by SMS.">
                <TextInput
                  accessibilityLabel="Verification code"
                  style={[styles.input, auth.codeInput]}
                  placeholder="······"
                  placeholderTextColor={colors.inkSoft}
                  keyboardType="number-pad"
                  value={code}
                  onChangeText={setCode}
                />
              </Field>
            </FadeSlideIn>
          ) : null}

          {mode === 'signUp' ? <View nativeID="clerk-captcha" /> : null}
          {error ? <ErrorNote>{error}</ErrorNote> : null}

          <PressableScale
            accessibilityRole="button"
            accessibilityLabel={pending ? 'Verify code' : 'Send code'}
            style={[styles.primaryButton, isFetching && styles.disabled]}
            disabled={isFetching}
            onPress={pending ? verifyOtp : startOtp}
          >
            <Text style={styles.primaryButtonText}>
              {isFetching ? 'Just a moment…' : pending ? 'Verify code' : 'Send code'}
            </Text>
          </PressableScale>
        </Card>
      </FadeSlideIn>
    </ScrollView>
  );
}

function readableAuthError(error: unknown, fallback: string): string {
  if (
    error &&
    typeof error === 'object' &&
    'longMessage' in error &&
    typeof error.longMessage === 'string'
  ) {
    return error.longMessage;
  }
  return error instanceof Error ? error.message : fallback;
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
  if (!households) return <Loading label="Opening your kitchen" />;
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
    <View style={{ flex: 1, backgroundColor: colors.surface }}>
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
      <View style={styles.segment}>
        {(
          [
            ['home', 'My home', homeCount],
            ['work', 'Work', workCount],
          ] as const
        ).map(([key, label, count]) => (
          <PressableScale
            key={key}
            accessibilityRole="button"
            accessibilityLabel={`${label}, ${count} households`}
            accessibilityState={{ selected: area === key }}
            style={[styles.segmentButton, areaStyles.tab, area === key && styles.segmentActive]}
            onPress={() => onChange(key)}
          >
            <Text style={[styles.segmentText, area === key && styles.segmentTextActive]}>
              {label}
            </Text>
            <Chip
              label={String(count)}
              tint={area === key ? colors.accentSoft : colors.field}
              ink={area === key ? colors.accent : colors.inkSoft}
            />
          </PressableScale>
        ))}
      </View>
    </View>
  );
}

const MEAL_STYLES = [
  { value: 'north', label: 'North Indian', glyph: '🫓', note: 'Roti, sabzi, dal' },
  { value: 'south', label: 'South Indian', glyph: '🍛', note: 'Rice, sambar, poriyal' },
] as const;

const DIET_STYLES = [
  { value: 'vegetarian', label: 'Veg', glyph: '🥬' },
  { value: 'eggetarian', label: 'Egg', glyph: '🥚' },
  { value: 'nonvegetarian', label: 'Non-veg', glyph: '🍗' },
] as const;

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
    setMessage('Building your first seven-day meal plan…');
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

  // The generation wait is the one moment worth a whole screen: Chotu at work
  // while the week is built reads as progress, not as a stalled request.
  if (busy) {
    return (
      <MascotState title="Cooking up your week" body={message ?? undefined} say="One minute!" />
    );
  }

  return (
    <ScrollView
      contentContainerStyle={onboard.scroll}
      keyboardShouldPersistTaps="handled"
      showsVerticalScrollIndicator={false}
    >
      <FadeSlideIn>
        <View style={onboard.head}>
          <Mascot size={104} withPet={false} />
          <View style={onboard.headText}>
            <Text style={styles.eyebrow}>Owner setup</Text>
            <Text style={onboard.title}>Start your household</Text>
          </View>
        </View>
      </FadeSlideIn>

      <FadeSlideIn delay={90}>
        <Card>
          <Field label="Household name">
            <TextInput
              accessibilityLabel="Household name"
              style={styles.input}
              value={name}
              onChangeText={setName}
              placeholder="My Home"
              placeholderTextColor={colors.inkSoft}
            />
          </Field>
          <Field label="Usual number of diners" hint="You can override this on any single meal.">
            <TextInput
              accessibilityLabel="Serving count"
              style={styles.input}
              value={servingCount}
              onChangeText={setServingCount}
              placeholder="4"
              placeholderTextColor={colors.inkSoft}
              keyboardType="number-pad"
            />
          </Field>
        </Card>
      </FadeSlideIn>

      <FadeSlideIn delay={160}>
        <Card>
          <Field label="Meal style">
            <View style={onboard.choiceRow}>
              {MEAL_STYLES.map((option) => {
                const selected = mealStyle === option.value;
                return (
                  <PressableScale
                    key={option.value}
                    accessibilityRole="button"
                    accessibilityLabel={option.label}
                    accessibilityState={{ selected }}
                    style={[onboard.choice, selected && onboard.choiceOn]}
                    onPress={() => setMealStyle(option.value)}
                  >
                    <Text style={onboard.choiceGlyph}>{option.glyph}</Text>
                    <Text style={[onboard.choiceLabel, selected && onboard.choiceLabelOn]}>
                      {option.label}
                    </Text>
                    <Text style={onboard.choiceNote}>{option.note}</Text>
                  </PressableScale>
                );
              })}
            </View>
          </Field>
        </Card>
      </FadeSlideIn>

      <FadeSlideIn delay={230}>
        <Card>
          <Field label="Food preference" hint="Guides planning; you can still swap in any meal.">
            <View style={onboard.choiceRow}>
              {DIET_STYLES.map((option) => {
                const selected = dietStyle === option.value;
                return (
                  <PressableScale
                    key={option.value}
                    accessibilityRole="button"
                    accessibilityLabel={option.label}
                    accessibilityState={{ selected }}
                    style={[onboard.diet, selected && onboard.choiceOn]}
                    onPress={() => setDietStyle(option.value)}
                  >
                    <Text style={onboard.dietGlyph}>{option.glyph}</Text>
                    <Text
                      numberOfLines={1}
                      style={[
                        onboard.choiceLabel,
                        onboard.dietLabel,
                        selected && onboard.choiceLabelOn,
                      ]}
                    >
                      {option.label}
                    </Text>
                  </PressableScale>
                );
              })}
            </View>
          </Field>
        </Card>
      </FadeSlideIn>

      <FadeSlideIn delay={300}>
        <View style={{ gap: space.md }}>
          {message ? <Text style={styles.subtitle}>{message}</Text> : null}
          <PressableScale
            accessibilityRole="button"
            accessibilityLabel="Create active meal plan"
            style={styles.primaryButton}
            onPress={createHousehold}
          >
            <Text style={styles.primaryButtonText}>Create my meal plan</Text>
          </PressableScale>
          {onCancel ? (
            <PressableScale
              accessibilityRole="button"
              accessibilityLabel="Back to join choices"
              style={styles.ghostButton}
              onPress={onCancel}
            >
              <Text style={styles.ghostButtonText}>Back</Text>
            </PressableScale>
          ) : null}
        </View>
      </FadeSlideIn>
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
    <MascotState
      title="Set up your household"
      body="Start your own household, or accept the invite someone sent you on WhatsApp."
      say="Namaste!"
    >
      <View style={noHouse.actions}>
        <PressableScale
          accessibilityRole="button"
          accessibilityLabel="Start a household"
          style={styles.primaryButton}
          onPress={onStart}
        >
          <Text style={styles.primaryButtonText}>Start a household</Text>
        </PressableScale>
        <PressableScale
          accessibilityRole="button"
          accessibilityLabel="Accept an invite"
          style={styles.ghostButton}
          onPress={onAcceptInvite}
        >
          <Text style={styles.ghostButtonText}>I have an invite</Text>
        </PressableScale>
      </View>
    </MascotState>
  );
}

const auth = StyleSheet.create({
  scroll: {
    flexGrow: 1,
    justifyContent: 'center',
    paddingHorizontal: space.xl,
    paddingVertical: space.xxl,
    backgroundColor: colors.surface,
    gap: space.lg,
  },
  hero: { alignItems: 'center' },
  intro: { alignItems: 'center', gap: space.sm },
  tagline: {
    fontSize: 15,
    lineHeight: 21,
    color: colors.inkSoft,
    textAlign: 'center',
    maxWidth: 280,
  },
  card: { gap: space.lg, padding: space.xl },
  codeInput: { fontSize: 24, letterSpacing: 8, textAlign: 'center' },
});

const onboard = StyleSheet.create({
  scroll: {
    flexGrow: 1,
    paddingHorizontal: space.xl,
    paddingTop: 56,
    paddingBottom: space.xxl,
    backgroundColor: colors.surface,
    gap: space.md,
  },
  head: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  headText: { flex: 1, gap: space.xs },
  title: {
    fontFamily: fonts.display,
    fontSize: 30,
    lineHeight: 35,
    fontWeight: '700',
    color: colors.ink,
    letterSpacing: -0.3,
  },
  choiceRow: { flexDirection: 'row', gap: space.sm },
  choice: {
    flex: 1,
    minHeight: 44,
    gap: 2,
    borderRadius: radius.md,
    borderWidth: 2,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    paddingVertical: space.md,
    paddingHorizontal: space.md,
  },
  choiceOn: { borderColor: colors.accent, backgroundColor: colors.accentSoft, ...shadow.soft },
  choiceGlyph: { fontSize: 22 },
  choiceLabel: { fontSize: 15, fontWeight: '700', color: colors.ink },
  choiceLabelOn: { color: colors.accent },
  choiceNote: { fontSize: 12, color: colors.inkSoft, lineHeight: 16 },
  diet: {
    flex: 1,
    minHeight: 44,
    alignItems: 'center',
    gap: space.xs,
    borderRadius: radius.md,
    borderWidth: 2,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    paddingVertical: space.md,
  },
  dietGlyph: { fontSize: 20 },
  dietLabel: { fontSize: 14 },
});

const noHouse = StyleSheet.create({
  actions: { alignSelf: 'stretch', gap: space.md, marginTop: space.lg },
});

const areaStyles = StyleSheet.create({
  bar: {
    paddingHorizontal: space.xl,
    paddingTop: 56,
    paddingBottom: space.sm,
    backgroundColor: colors.surface,
  },
  tab: { flexDirection: 'row', gap: space.sm },
});
