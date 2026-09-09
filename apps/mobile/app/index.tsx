import { useCallback, useEffect, useState } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';
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
} from '../src/components/design-system';
import { BrandLogo } from '../src/components/BrandLogo';
import { Mascot, MascotState } from '../src/components/Mascot';
import { MemberShell } from '../src/screens/MemberShell';
import { CookShell } from '../src/screens/CookShell';
import { Text, TextInput } from '../src/components/Typography';
import { identifyAnalyticsUser, resetAnalyticsUser } from '../src/lib/analytics';

const DESIGN_PREVIEW_HOUSEHOLD = {
  id: 'preview-household',
  name: 'Sharma Home',
  role: 'member',
  servingCount: 4,
  mealStyle: 'north',
  dietStyle: 'vegetarian',
  defaultLanguage: 'en',
} as const;

const SELECTED_ACCESSIBILITY_STATE = { selected: true } as const;
const UNSELECTED_ACCESSIBILITY_STATE = { selected: false } as const;
const EXPANDED_ACCESSIBILITY_STATE = { expanded: true } as const;
const COLLAPSED_ACCESSIBILITY_STATE = { expanded: false } as const;
const DISABLED_ACCESSIBILITY_STATE = { disabled: true } as const;

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
  const designPreview = process.env.EXPO_PUBLIC_COOKLINK_DESIGN_PREVIEW;
  if (__DEV__ && designPreview === 'onboarding') {
    return <OnboardingConversionPreview />;
  }
  if (__DEV__ && designPreview === 'true') {
    return <MemberShell household={DESIGN_PREVIEW_HOUSEHOLD} />;
  }
  return <AuthenticatedHome />;
}

function OnboardingConversionPreview() {
  const router = useRouter();
  const [ownerSetup, setOwnerSetup] = useState(false);
  const [complete, setComplete] = useState(false);
  const startOwnerSetup = useCallback(() => setOwnerSetup(true), []);
  const cancelOwnerSetup = useCallback(() => setOwnerSetup(false), []);
  const openInvite = useCallback(
    (expectedRole: 'member' | 'cook') => router.push(`/invite?expected_role=${expectedRole}`),
    [router],
  );
  const createPreviewHousehold = useCallback(async (): Promise<HouseholdCreationResult> => {
    await new Promise((resolve) => setTimeout(resolve, 700));
    return { householdId: 'preview-household', mealCount: 21 };
  }, []);
  const finishPreview = useCallback(async () => setComplete(true), []);

  if (complete) {
    return (
      <View testID="onboarding-complete-screen" style={appStyles.root}>
        <MascotState
          title="Your first week is ready"
          body="21 meals are active. You can adjust any meal from the plan."
          say="Ready!"
        />
      </View>
    );
  }

  return ownerSetup ? (
    <OwnerOnboarding
      onCreated={finishPreview}
      onCancel={cancelOwnerSetup}
      createHouseholdRequest={createPreviewHousehold}
    />
  ) : (
    <NoHouseholds onStart={startOwnerSetup} onAcceptInvite={openInvite} />
  );
}

function AuthenticatedHome() {
  const { isLoaded, isSignedIn, user } = useUser();
  const router = useRouter();
  const params = useLocalSearchParams<{ pending_invite_token?: string }>();

  useEffect(() => {
    if (devAuthEnabled) {
      identifyAnalyticsUser(
        process.env.EXPO_PUBLIC_COOKLINK_DEV_USER_ID ?? 'cooklink-mobile-dev-owner',
      );
      return;
    }
    if (!isLoaded) return;
    if (isSignedIn && user) identifyAnalyticsUser(user.id);
    else resetAnalyticsUser();
  }, [isLoaded, isSignedIn, user]);

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

  const switchMode = useCallback(
    (next: 'signIn' | 'signUp') => {
      setMode(next);
      setPending(false);
      setCode('');
      setError(null);
      if (next === 'signIn') void signUp.reset();
      else void signIn.reset();
    },
    [signIn, signUp],
  );
  const switchToSignIn = useCallback(() => switchMode('signIn'), [switchMode]);
  const switchToSignUp = useCallback(() => switchMode('signUp'), [switchMode]);

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
              accessibilityState={
                mode === 'signIn' ? SELECTED_ACCESSIBILITY_STATE : UNSELECTED_ACCESSIBILITY_STATE
              }
              style={mode === 'signIn' ? SEGMENT_BUTTON_ACTIVE_STYLE : styles.segmentButton}
              disabled={isFetching}
              onPress={switchToSignIn}
            >
              <Text style={mode === 'signIn' ? SEGMENT_TEXT_ACTIVE_STYLE : styles.segmentText}>
                Sign in
              </Text>
            </PressableScale>
            <PressableScale
              accessibilityRole="button"
              accessibilityLabel="Create account"
              accessibilityState={
                mode === 'signUp' ? SELECTED_ACCESSIBILITY_STATE : UNSELECTED_ACCESSIBILITY_STATE
              }
              style={mode === 'signUp' ? SEGMENT_BUTTON_ACTIVE_STYLE : styles.segmentButton}
              disabled={isFetching}
              onPress={switchToSignUp}
            >
              <Text style={mode === 'signUp' ? SEGMENT_TEXT_ACTIVE_STYLE : styles.segmentText}>
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
                  style={CODE_INPUT_STYLE}
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
            style={isFetching ? DISABLED_PRIMARY_BUTTON_STYLE : styles.primaryButton}
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
  const cancelOnboarding = useCallback(() => setOnboarding(false), []);
  const startOnboarding = useCallback(() => setOnboarding(true), []);
  const acceptInvite = useCallback(
    (expectedRole: 'member' | 'cook') => router.push(`/invite?expected_role=${expectedRole}`),
    [router],
  );
  const profileRequired = error?.includes('profile_required') ?? false;

  // A profile_required error means the person has no Clerk user row yet; the
  // server creates it lazily. A no-households state offers the owner onboarding
  // path AND the invite-acceptance path (issue 03 — a Member or Cook lands here
  // with zero households until they accept their WhatsApp invite).
  if (error && !profileRequired) return <Message title="Could not load Cooklink" body={error} />;
  if (!profileRequired && !households) return <Loading label="Opening your kitchen" />;
  if (profileRequired || households?.length === 0) {
    return onboarding ? (
      <OwnerOnboarding onCreated={loadHouseholds} onCancel={cancelOnboarding} />
    ) : (
      <NoHouseholds onStart={startOnboarding} onAcceptInvite={acceptInvite} />
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
    <View style={appStyles.root}>
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
          <AreaSwitchTab
            key={key}
            areaKey={key}
            label={label}
            count={count}
            selected={area === key}
            onChange={onChange}
          />
        ))}
      </View>
    </View>
  );
}

function AreaSwitchTab({
  areaKey,
  label,
  count,
  selected,
  onChange,
}: {
  areaKey: 'home' | 'work';
  label: string;
  count: number;
  selected: boolean;
  onChange: (next: 'home' | 'work') => void;
}) {
  const selectArea = useCallback(() => onChange(areaKey), [areaKey, onChange]);

  return (
    <PressableScale
      accessibilityRole="button"
      accessibilityLabel={`${label}, ${count} households`}
      accessibilityState={selected ? SELECTED_ACCESSIBILITY_STATE : UNSELECTED_ACCESSIBILITY_STATE}
      style={selected ? AREA_TAB_ACTIVE_STYLE : AREA_TAB_STYLE}
      onPress={selectArea}
    >
      <Text style={selected ? SEGMENT_TEXT_ACTIVE_STYLE : styles.segmentText}>{label}</Text>
      <Chip
        label={String(count)}
        tint={selected ? colors.accentSoft : colors.field}
        ink={selected ? colors.accent : colors.inkSoft}
      />
    </PressableScale>
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

type HouseholdCreationInput = {
  name: string;
  servingCount: number;
  mealStyle: 'north' | 'south';
  dietStyle: 'vegetarian' | 'eggetarian' | 'nonvegetarian';
};

type HouseholdCreationResult = {
  householdId: string;
  mealCount: number;
};

function OwnerOnboarding({
  onCreated,
  onCancel,
  createHouseholdRequest,
}: {
  onCreated: () => Promise<unknown>;
  onCancel?: () => void;
  createHouseholdRequest?: (input: HouseholdCreationInput) => Promise<HouseholdCreationResult>;
}) {
  const api = useApi();
  const [name, setName] = useState('My Home');
  const [servingCount, setServingCount] = useState('4');
  const [mealStyle, setMealStyle] = useState<'north' | 'south'>('north');
  const [dietStyle, setDietStyle] = useState<'vegetarian' | 'eggetarian' | 'nonvegetarian'>(
    'vegetarian',
  );
  const [showPersonalization, setShowPersonalization] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const parsedServingCount = Number(servingCount);
  const canCreate =
    name.trim().length > 0 &&
    Number.isInteger(parsedServingCount) &&
    parsedServingCount > 0 &&
    parsedServingCount <= 20;
  const togglePersonalization = useCallback(
    () => setShowPersonalization((visible) => !visible),
    [],
  );

  const createHousehold = useCallback(async () => {
    if (!canCreate) {
      setMessage('Add a household name and use a diner count from 1 to 20.');
      return;
    }
    setBusy(true);
    setMessage('Building your first seven-day meal plan…');
    const startedAt = Date.now();
    try {
      const input: HouseholdCreationInput = {
        name: name.trim(),
        servingCount: parsedServingCount,
        mealStyle,
        dietStyle,
      };
      const result = createHouseholdRequest
        ? await createHouseholdRequest(input)
        : await api<HouseholdCreationResult>('/v1/households', {
            method: 'POST',
            body: JSON.stringify(input),
          });
      const elapsed = Math.round((Date.now() - startedAt) / 1000);
      setMessage(`${result.mealCount} meals active in ${elapsed}s.`);
      await onCreated();
    } catch (err) {
      setMessage(err instanceof Error ? err.message : 'Could not create your household.');
    } finally {
      setBusy(false);
    }
  }, [
    api,
    canCreate,
    createHouseholdRequest,
    dietStyle,
    mealStyle,
    name,
    onCreated,
    parsedServingCount,
  ]);

  // The generation wait is the one moment worth a whole screen: Chotu at work
  // while the week is built reads as progress, not as a stalled request.
  if (busy) {
    return (
      <MascotState
        title="Cooking up your week"
        body={message ?? undefined}
        say="About 15 seconds!"
      />
    );
  }

  return (
    <ScrollView
      testID="owner-onboarding-screen"
      contentContainerStyle={onboard.scroll}
      keyboardShouldPersistTaps="handled"
      showsVerticalScrollIndicator={false}
    >
      <FadeSlideIn>
        <View style={onboard.head}>
          <Mascot size={104} withPet={false} />
          <View style={onboard.headText}>
            <Text style={styles.eyebrow}>Step 2 of 2 · Owner setup</Text>
            <Text style={onboard.title}>Your first week, ready in about 15 seconds</Text>
            <Text style={styles.subtitle}>
              Name your household and Cooklink will create an active seven-day meal plan.
            </Text>
          </View>
        </View>
      </FadeSlideIn>

      <FadeSlideIn delay={90}>
        <Card>
          <Field label="Household name (required)" hint="“My Home” is ready—rename it if you like.">
            <TextInput
              accessibilityLabel="Household name, required"
              style={styles.input}
              value={name}
              onChangeText={setName}
              placeholder="My Home"
              placeholderTextColor={colors.inkSoft}
            />
          </Field>
        </Card>
      </FadeSlideIn>

      <FadeSlideIn delay={160}>
        <Card style={onboard.defaultsCard}>
          <View style={onboard.defaultsHead}>
            <View style={onboard.defaultsCopy}>
              <Text style={styles.eyebrow}>Starter choices</Text>
              <Text style={onboard.defaultsTitle}>
                {servingCount} diners · {mealStyle === 'north' ? 'North Indian' : 'South Indian'} ·{' '}
                {dietStyle === 'vegetarian'
                  ? 'Vegetarian'
                  : dietStyle === 'eggetarian'
                    ? 'Eggetarian'
                    : 'Non-vegetarian'}
              </Text>
            </View>
            <Chip label="Optional" tint={colors.oliveSoft} ink={colors.olive} />
          </View>
          <Text style={styles.subtitle}>
            These defaults are enough to start. Personalize them now only if you want to.
          </Text>
          <PressableScale
            testID="toggle-onboarding-personalization"
            accessibilityRole="button"
            accessibilityLabel={
              showPersonalization
                ? 'Hide optional personalization'
                : 'Personalize before creating plan'
            }
            accessibilityState={
              showPersonalization ? EXPANDED_ACCESSIBILITY_STATE : COLLAPSED_ACCESSIBILITY_STATE
            }
            style={styles.ghostButton}
            onPress={togglePersonalization}
          >
            <Text style={styles.ghostButtonText}>
              {showPersonalization ? 'Use these choices' : 'Personalize first (optional)'}
            </Text>
          </PressableScale>
        </Card>
      </FadeSlideIn>

      {showPersonalization ? (
        <FadeSlideIn delay={90}>
          <View style={onboard.personalization}>
            <Card>
              <Field
                label="Usual number of diners"
                hint="Optional. You can override this on any single meal."
              >
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

            <Card>
              <Field label="Meal style" hint="Optional. North Indian is selected by default.">
                <View style={onboard.choiceRow}>
                  {MEAL_STYLES.map((option) => (
                    <MealStyleOption
                      key={option.value}
                      option={option}
                      selected={mealStyle === option.value}
                      onSelect={setMealStyle}
                    />
                  ))}
                </View>
              </Field>
            </Card>

            <Card>
              <Field
                label="Food preference"
                hint="Optional. Guides planning; you can still swap in any meal."
              >
                <View style={onboard.choiceRow}>
                  {DIET_STYLES.map((option) => (
                    <DietStyleOption
                      key={option.value}
                      option={option}
                      selected={dietStyle === option.value}
                      onSelect={setDietStyle}
                    />
                  ))}
                </View>
              </Field>
            </Card>
          </View>
        </FadeSlideIn>
      ) : null}

      <FadeSlideIn delay={230}>
        <View style={onboard.actions}>
          {message ? <Text style={styles.subtitle}>{message}</Text> : null}
          <PressableScale
            testID="create-first-plan-button"
            accessibilityRole="button"
            accessibilityLabel="Create active meal plan"
            accessibilityState={canCreate ? undefined : DISABLED_ACCESSIBILITY_STATE}
            style={canCreate ? styles.primaryButton : DISABLED_PRIMARY_BUTTON_STYLE}
            disabled={!canCreate}
            onPress={createHousehold}
          >
            <Text style={styles.primaryButtonText}>Create my 7-day plan</Text>
          </PressableScale>
          <Text style={onboard.timeNote}>Usually ready in about 15 seconds.</Text>
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

function MealStyleOption({
  option,
  selected,
  onSelect,
}: {
  option: (typeof MEAL_STYLES)[number];
  selected: boolean;
  onSelect: (value: (typeof MEAL_STYLES)[number]['value']) => void;
}) {
  const selectOption = useCallback(() => onSelect(option.value), [onSelect, option.value]);

  return (
    <PressableScale
      accessibilityRole="button"
      accessibilityLabel={option.label}
      accessibilityState={selected ? SELECTED_ACCESSIBILITY_STATE : UNSELECTED_ACCESSIBILITY_STATE}
      style={selected ? MEAL_CHOICE_ACTIVE_STYLE : onboard.choice}
      onPress={selectOption}
    >
      <Text style={onboard.choiceGlyph}>{option.glyph}</Text>
      <Text style={selected ? CHOICE_LABEL_ACTIVE_STYLE : onboard.choiceLabel}>{option.label}</Text>
      <Text style={onboard.choiceNote}>{option.note}</Text>
    </PressableScale>
  );
}

function DietStyleOption({
  option,
  selected,
  onSelect,
}: {
  option: (typeof DIET_STYLES)[number];
  selected: boolean;
  onSelect: (value: (typeof DIET_STYLES)[number]['value']) => void;
}) {
  const selectOption = useCallback(() => onSelect(option.value), [onSelect, option.value]);

  return (
    <PressableScale
      accessibilityRole="button"
      accessibilityLabel={option.label}
      accessibilityState={selected ? SELECTED_ACCESSIBILITY_STATE : UNSELECTED_ACCESSIBILITY_STATE}
      style={selected ? DIET_CHOICE_ACTIVE_STYLE : onboard.diet}
      onPress={selectOption}
    >
      <Text style={onboard.dietGlyph}>{option.glyph}</Text>
      <Text numberOfLines={1} style={selected ? DIET_LABEL_ACTIVE_STYLE : DIET_LABEL_STYLE}>
        {option.label}
      </Text>
    </PressableScale>
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
  onAcceptInvite: (expectedRole: 'member' | 'cook') => void;
}) {
  const joinAsMember = useCallback(() => onAcceptInvite('member'), [onAcceptInvite]);
  const joinAsCook = useCallback(() => onAcceptInvite('cook'), [onAcceptInvite]);

  return (
    <ScrollView
      testID="role-first-screen"
      contentContainerStyle={noHouse.scroll}
      showsVerticalScrollIndicator={false}
    >
      <Mascot size={138} say="Namaste!" />
      <Text style={noHouse.title}>How do you use Cooklink?</Text>
      <Text style={noHouse.body}>
        Choose one role. Cooklink will take you to the shortest setup for it.
      </Text>
      <View style={noHouse.actions}>
        <Text style={styles.eyebrow}>Step 1 of 2 · Choose your role</Text>
        <PressableScale
          testID="choose-owner-role"
          accessibilityRole="button"
          accessibilityLabel="Household owner, set up my home"
          style={noHouse.roleChoicePrimary}
          onPress={onStart}
        >
          <View style={noHouse.roleCopy}>
            <Text style={noHouse.roleTitlePrimary}>Household owner</Text>
            <Text style={noHouse.roleNotePrimary}>
              Set up my home and create its first meal plan
            </Text>
          </View>
          <Text style={noHouse.roleArrowPrimary}>→</Text>
        </PressableScale>
        <PressableScale
          testID="choose-member-role"
          accessibilityRole="button"
          accessibilityLabel="Household member, join with an invite"
          style={noHouse.roleChoice}
          onPress={joinAsMember}
        >
          <View style={noHouse.roleCopy}>
            <Text style={noHouse.roleTitle}>Household member</Text>
            <Text style={noHouse.roleNote}>Join my household with its WhatsApp invite</Text>
          </View>
          <Text style={noHouse.roleArrow}>→</Text>
        </PressableScale>
        <PressableScale
          testID="choose-cook-role"
          accessibilityRole="button"
          accessibilityLabel="Hired cook, join work households"
          style={noHouse.roleChoice}
          onPress={joinAsCook}
        >
          <View style={noHouse.roleCopy}>
            <Text style={noHouse.roleTitle}>Hired cook</Text>
            <Text style={noHouse.roleNote}>Join the homes I cook for with an invite</Text>
          </View>
          <Text style={noHouse.roleArrow}>→</Text>
        </PressableScale>
      </View>
    </ScrollView>
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
  actions: { gap: space.md },
  defaultsCard: { gap: space.md },
  defaultsHead: { flexDirection: 'row', alignItems: 'flex-start', gap: space.sm },
  defaultsCopy: { flex: 1, gap: space.xs },
  defaultsTitle: { fontSize: 16, lineHeight: 22, fontWeight: '700', color: colors.ink },
  personalization: { gap: space.md },
  timeNote: { fontSize: 13, color: colors.inkSoft, textAlign: 'center' },
});

const noHouse = StyleSheet.create({
  scroll: {
    flexGrow: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: space.xl,
    paddingTop: 48,
    paddingBottom: space.xxl,
    gap: space.md,
    backgroundColor: colors.surface,
  },
  title: {
    fontFamily: fonts.display,
    fontSize: 30,
    lineHeight: 36,
    fontWeight: '700',
    color: colors.ink,
    textAlign: 'center',
  },
  body: {
    fontSize: 16,
    lineHeight: 23,
    color: colors.inkSoft,
    textAlign: 'center',
    maxWidth: 320,
  },
  actions: { alignSelf: 'stretch', gap: space.md, marginTop: space.sm },
  roleChoice: {
    minHeight: 72,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    borderRadius: radius.md,
    borderWidth: 2,
    borderColor: colors.border,
    backgroundColor: colors.card,
    padding: space.lg,
  },
  roleChoicePrimary: {
    minHeight: 72,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    borderRadius: radius.md,
    borderWidth: 2,
    borderColor: colors.accent,
    backgroundColor: colors.accent,
    padding: space.lg,
    ...shadow.soft,
  },
  roleCopy: { flex: 1, gap: space.xs },
  roleTitle: { fontSize: 16, fontWeight: '800', color: colors.ink },
  roleTitlePrimary: { fontSize: 16, fontWeight: '800', color: colors.card },
  roleNote: { fontSize: 13, lineHeight: 18, color: colors.inkSoft },
  roleNotePrimary: { fontSize: 13, lineHeight: 18, color: colors.card },
  roleArrow: { fontSize: 22, color: colors.accent },
  roleArrowPrimary: { fontSize: 22, color: colors.card },
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

const appStyles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.surface },
});

const SEGMENT_BUTTON_ACTIVE_STYLE = [styles.segmentButton, styles.segmentActive];
const SEGMENT_TEXT_ACTIVE_STYLE = [styles.segmentText, styles.segmentTextActive];
const CODE_INPUT_STYLE = [styles.input, auth.codeInput];
const DISABLED_PRIMARY_BUTTON_STYLE = [styles.primaryButton, styles.disabled];
const AREA_TAB_STYLE = [styles.segmentButton, areaStyles.tab];
const AREA_TAB_ACTIVE_STYLE = [styles.segmentButton, areaStyles.tab, styles.segmentActive];
const MEAL_CHOICE_ACTIVE_STYLE = [onboard.choice, onboard.choiceOn];
const CHOICE_LABEL_ACTIVE_STYLE = [onboard.choiceLabel, onboard.choiceLabelOn];
const DIET_CHOICE_ACTIVE_STYLE = [onboard.diet, onboard.choiceOn];
const DIET_LABEL_STYLE = [onboard.choiceLabel, onboard.dietLabel];
const DIET_LABEL_ACTIVE_STYLE = [onboard.choiceLabel, onboard.dietLabel, onboard.choiceLabelOn];
