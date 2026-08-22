import {
  createContext,
  memo,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  type ReactNode,
} from 'react';
import {
  Animated,
  Easing,
  Platform,
  Pressable,
  StyleSheet,
  View,
  useWindowDimensions,
  type PressableProps,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import { BlurView } from 'expo-blur';
import { GlassView, isLiquidGlassAvailable } from 'expo-glass-effect';
import * as Haptics from 'expo-haptics';
import { SymbolView, type SymbolViewProps } from 'expo-symbols';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Reanimated, {
  Extrapolation,
  interpolate,
  interpolateColor,
  runOnJS,
  useAnimatedScrollHandler,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  type SharedValue,
} from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Text } from './Typography';
import { fonts } from '../theme/typography';

export { fonts } from '../theme/typography';

const AnimatedGlassView = Reanimated.createAnimatedComponent(GlassView);

/**
 * Cooklink design system — "Warm Kitchen".
 *
 * One household, one cook, one shared table. The visual language borrows from
 * an Indian home kitchen: cream ghee-paper surfaces, deep curry-leaf green for
 * anything actionable, cinnamon for labels, turmeric and paprika for accents.
 * Headlines are set in a serif so the app reads like a handwritten menu rather
 * than a dashboard; everything interactive is a pill.
 *
 * This module is the single source of design truth — colour, type, spacing,
 * radius, elevation, and motion all live here so no screen invents its own.
 * Files may import from here; this file imports from nothing local, which keeps
 * the dependency graph one-directional.
 *
 * Accessibility contract (issue 03 / issue 13, AC#2): every text colour below
 * clears WCAG AA against the surfaces it is used on, and every Pressable here
 * carries at least 44pt of touch target. `src/tests/accessibility.test.ts`
 * parses this file to enforce both.
 */

// ---------------------------------------------------------------------------
// Colour
// ---------------------------------------------------------------------------

export const colors = {
  // Sleek's Warm Cookbook is printed on a barely warm paper canvas. Neutral
  // controls sit one tone deeper; food photography supplies nearly all colour.
  surface: '#FDFCF8',
  surfaceDeep: '#F3EFE6',
  card: '#FFFFFF',
  field: '#F3EFE6',
  border: '#E7E2DA',

  // Text. `ink` and `inkSoft` both clear 4.5:1 on surface and card.
  ink: '#1D1C19',
  inkSoft: '#6F6B65',

  // The sampled coral is retained for large/decorative accents. The semantic
  // action shade is slightly darker so small text and white button labels keep
  // their contrast on a real device.
  coral: '#C9624A',
  accent: '#B64E39',
  accentSoft: '#FDE5DB',
  olive: '#5F6B48',
  oliveSoft: '#E7E9DF',

  // Cinnamon: eyebrows, day headings, meal-type labels.
  brand: '#74685C',
  brandSoft: '#F3EFE6',

  // Warning red, and the two decorative spices (never used behind body text).
  danger: '#A32E1E',
  dangerSoft: '#FBEAE6',
  turmeric: '#C89A45',
  paprika: '#D9612C',

  // Translucent structural surfaces.
  scrim: 'rgba(28,20,12,0.45)',
  glassMaterial: 'rgba(253, 252, 248, 0.42)',
  glassFallback: 'rgba(255, 255, 255, 0.94)',
  glassBorder: 'rgba(231, 226, 218, 0.88)',
  glassHighlight: 'rgba(201, 98, 74, 0.14)',
};

/**
 * Per-meal accent so breakfast, lunch, and dinner are told apart at a glance.
 * The text key is `label` rather than `ink` so it cannot shadow the palette's
 * `ink` in the accessibility test's colour parser.
 */
export const mealAccents: Record<string, { tint: string; label: string; glyph: string }> = {
  breakfast: { tint: '#FBEBD2', label: '#8A5A15', glyph: '🫓' },
  lunch: { tint: '#DEEBDC', label: '#3C6B3A', glyph: '🍛' },
  dinner: { tint: '#E6E2F0', label: '#4E4477', glyph: '🍲' },
};

export function mealAccent(mealType: string) {
  return (
    mealAccents[mealType.toLowerCase()] ?? { tint: colors.field, label: colors.brand, glyph: '🍽' }
  );
}

// ---------------------------------------------------------------------------
// Type, space, radius, elevation, motion
// ---------------------------------------------------------------------------

export const space = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32 };

export const radius = { sm: 12, md: 16, lg: 22, xl: 30, pill: 999 };

export const shadow = {
  /** Resting cards. */
  soft: {
    shadowColor: '#000000',
    shadowOpacity: 0.06,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 4 },
    elevation: 2,
  },
  /** Hero cards, sheets, and the tab bar. */
  lift: {
    shadowColor: '#000000',
    shadowOpacity: 0.12,
    shadowRadius: 20,
    shadowOffset: { width: 0, height: 8 },
    elevation: 8,
  },
};

/**
 * Motion is spring-first: presses and selections use springs so they can be
 * interrupted mid-flight, while entrances use short eased timings. Everything
 * runs on the native driver, so nothing here can be blocked by JS work.
 */
export const motion = {
  press: { friction: 6, tension: 320, useNativeDriver: true },
  select: { friction: 7, tension: 180, useNativeDriver: true },
  enterMs: 420,
  easeOut: Easing.bezier(0.16, 1, 0.3, 1),
};

// ---------------------------------------------------------------------------
// Motion primitives
// ---------------------------------------------------------------------------

/**
 * The Pressable itself is the animated view, rather than being nested inside
 * one. That matters for layout: a wrapper view would swallow `flex: 1` and any
 * other layout style passed in, so a row of these would size to content instead
 * of sharing the row evenly.
 */
const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

/**
 * A Pressable that springs down under the finger. Using this everywhere instead
 * of styling each button means every tappable surface gets the same physical
 * feedback, and accessibility props pass straight through.
 */
export function PressableScale({
  children,
  style,
  to = 0.96,
  ...rest
}: Omit<PressableProps, 'style'> & {
  children: ReactNode;
  style?: StyleProp<ViewStyle>;
  to?: number;
}) {
  const scale = useRef(new Animated.Value(1)).current;
  const restOnPressIn = rest.onPressIn;
  const restOnPressOut = rest.onPressOut;
  const spring = useCallback(
    (value: number) => Animated.spring(scale, { toValue: value, ...motion.press }).start(),
    [scale],
  );
  const scaleStyle = useMemo(() => ({ transform: [{ scale }] }), [scale]);
  const handlePressIn = useCallback<NonNullable<PressableProps['onPressIn']>>(
    (event) => {
      spring(to);
      restOnPressIn?.(event);
    },
    [restOnPressIn, spring, to],
  );
  const handlePressOut = useCallback<NonNullable<PressableProps['onPressOut']>>(
    (event) => {
      spring(1);
      restOnPressOut?.(event);
    },
    [restOnPressOut, spring],
  );

  return (
    <AnimatedPressable
      {...rest}
      style={StyleSheet.compose(style, scaleStyle)}
      onPressIn={handlePressIn}
      onPressOut={handlePressOut}
    >
      {children}
    </AnimatedPressable>
  );
}

/**
 * Fades and lifts its children in on mount. Passing an increasing `delay` down
 * a list is how every screen here staggers its content, so a screen assembles
 * itself top-to-bottom instead of appearing all at once.
 */
export function FadeSlideIn({
  children,
  delay = 0,
  from = 16,
  style,
}: {
  children: ReactNode;
  delay?: number;
  from?: number;
  style?: ViewStyle | ViewStyle[];
}) {
  const progress = useRef(new Animated.Value(0)).current;
  const animatedStyle = useMemo(
    () => ({
      opacity: progress,
      transform: [
        { translateY: progress.interpolate({ inputRange: [0, 1], outputRange: [from, 0] }) },
      ],
    }),
    [from, progress],
  );

  useEffect(() => {
    Animated.timing(progress, {
      toValue: 1,
      duration: motion.enterMs,
      delay,
      easing: motion.easeOut,
      useNativeDriver: true,
    }).start();
  }, [delay, progress]);

  return <Animated.View style={StyleSheet.compose(style, animatedStyle)}>{children}</Animated.View>;
}

// ---------------------------------------------------------------------------
// Core styles
// ---------------------------------------------------------------------------

/* eslint-disable react-native/no-unused-styles -- exported design-system styles are consumed by other modules. */
export const styles = StyleSheet.create({
  screen: {
    flexGrow: 1,
    paddingHorizontal: space.xl,
    paddingTop: space.xl,
    paddingBottom: space.xxl,
    backgroundColor: colors.surface,
    gap: space.lg,
  },
  centerScreen: {
    flex: 1,
    padding: space.xl,
    justifyContent: 'center',
    backgroundColor: colors.surface,
    gap: space.lg,
  },

  // Type
  eyebrow: {
    fontSize: 12,
    fontWeight: '800',
    color: colors.brand,
    textTransform: 'uppercase',
    letterSpacing: 1.4,
  },
  title: {
    fontFamily: fonts.display,
    fontSize: 36,
    lineHeight: 42,
    fontWeight: '700',
    color: colors.ink,
    letterSpacing: -0.4,
  },
  sectionTitle: {
    fontFamily: fonts.display,
    fontSize: 21,
    fontWeight: '700',
    color: colors.ink,
  },
  subtitle: { fontSize: 16, lineHeight: 23, color: colors.inkSoft },
  cardTitle: {
    fontFamily: fonts.display,
    fontSize: 20,
    fontWeight: '700',
    color: colors.ink,
  },
  listItem: { fontSize: 15, color: colors.inkSoft, paddingVertical: space.xs },
  error: { color: colors.danger, fontSize: 15, lineHeight: 21 },
  backLink: { color: colors.accent, fontSize: 17, fontWeight: '700' },
  disabled: { opacity: 0.55 },

  // Fields
  input: {
    borderWidth: 1.5,
    borderColor: colors.border,
    borderRadius: radius.md,
    paddingHorizontal: space.lg,
    paddingVertical: 15,
    fontSize: 17,
    color: colors.ink,
    backgroundColor: colors.card,
  },

  // Buttons — all pills. `padding` is kept as a single value so the
  // accessibility test can verify the 44pt vertical floor from source.
  primaryButton: {
    padding: 17,
    paddingHorizontal: space.xl,
    borderRadius: radius.sm,
    backgroundColor: colors.accent,
    alignItems: 'center',
    justifyContent: 'center',
    ...shadow.soft,
  },
  primaryButtonText: { color: colors.card, fontSize: 17, fontWeight: '700', letterSpacing: 0.2 },
  secondaryButton: {
    padding: 15,
    paddingHorizontal: space.xl,
    borderRadius: radius.sm,
    backgroundColor: colors.ink,
    alignItems: 'center',
    justifyContent: 'center',
  },
  secondaryButtonText: { color: colors.card, fontSize: 16, fontWeight: '700' },
  /** Outline rather than filled, so it never competes with the primary pill. */
  ghostButton: {
    padding: 14,
    paddingHorizontal: 18,
    borderRadius: radius.sm,
    borderWidth: 1.5,
    borderColor: colors.border,
    backgroundColor: colors.card,
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 46,
  },
  ghostButtonText: { color: colors.ink, fontSize: 15, fontWeight: '700' },

  // Segmented control
  segment: {
    flexDirection: 'row',
    gap: space.xs,
    padding: space.xs,
    borderRadius: radius.pill,
    backgroundColor: colors.surfaceDeep,
  },
  segmentButton: {
    flex: 1,
    minHeight: 44,
    borderRadius: radius.pill,
    paddingVertical: space.md,
    paddingHorizontal: space.sm,
    alignItems: 'center',
    justifyContent: 'center',
  },
  segmentActive: { backgroundColor: colors.card, ...shadow.soft },
  segmentText: { color: colors.inkSoft, fontWeight: '700', fontSize: 15 },
  segmentTextActive: { color: colors.accent },

  // Cards
  card: {
    borderRadius: radius.lg,
    backgroundColor: colors.card,
    padding: space.xl,
    gap: space.md,
    ...shadow.soft,
  },
  selectedCard: { borderWidth: 2, borderColor: colors.accent },

  // Meal rows
  mealRow: { flexDirection: 'row', gap: space.md, alignItems: 'center' },
  dayGroup: { gap: space.md },
  mealType: {
    fontSize: 11,
    fontWeight: '800',
    color: colors.brand,
    textTransform: 'uppercase',
    letterSpacing: 1.1,
  },
  mealName: { flex: 1, fontFamily: fonts.display, fontSize: 18, color: colors.ink },
});
/* eslint-enable react-native/no-unused-styles */

// ---------------------------------------------------------------------------
// Small building blocks
// ---------------------------------------------------------------------------

/** A rounded label — role, count, status. Decorative; never the only signal. */
export function Chip({
  label,
  tint = colors.field,
  ink = colors.ink,
}: {
  label: string;
  tint?: string;
  ink?: string;
}) {
  const chipStyle = useMemo(() => ({ backgroundColor: tint }), [tint]);
  const textStyle = useMemo(() => ({ color: ink }), [ink]);
  return (
    <View style={StyleSheet.compose(chipStyles.chip, chipStyle)}>
      <Text style={StyleSheet.compose(chipStyles.text, textStyle)}>{label}</Text>
    </View>
  );
}

const chipStyles = StyleSheet.create({
  chip: { borderRadius: radius.pill, paddingHorizontal: 11, paddingVertical: 5 },
  text: { fontSize: 11, fontWeight: '800', textTransform: 'uppercase', letterSpacing: 0.9 },
});

/** A circular monogram standing in for a household or person. */
export function Avatar({ name, size = 40 }: { name: string; size?: number }) {
  const initial = name.trim().charAt(0).toUpperCase() || '·';
  const circleStyle = useMemo(
    () => ({ width: size, height: size, borderRadius: size / 2 }),
    [size],
  );
  const textStyle = useMemo(() => ({ fontSize: size * 0.42 }), [size]);
  return (
    <View style={StyleSheet.compose(avatarStyles.circle, circleStyle)}>
      <Text style={StyleSheet.compose(avatarStyles.text, textStyle)}>{initial}</Text>
    </View>
  );
}

const avatarStyles = StyleSheet.create({
  circle: { backgroundColor: colors.accentSoft, alignItems: 'center', justifyContent: 'center' },
  text: { fontFamily: fonts.display, fontWeight: '700', color: colors.accent },
});

export function Divider() {
  return <View style={buildingBlockStyles.divider} />;
}

/** A labelled form row. The label is a real caption, not placeholder text, so
 *  it survives once the field has a value. */
export function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <View style={buildingBlockStyles.field}>
      <Text style={fieldStyles.label}>{label}</Text>
      {children}
      {hint ? <Text style={fieldStyles.hint}>{hint}</Text> : null}
    </View>
  );
}

const fieldStyles = StyleSheet.create({
  label: { fontSize: 13, fontWeight: '800', color: colors.ink, letterSpacing: 0.2 },
  hint: { fontSize: 13, color: colors.inkSoft, lineHeight: 18 },
});

const buildingBlockStyles = StyleSheet.create({
  divider: { height: 1, backgroundColor: colors.border },
  field: { gap: space.sm },
  message: { gap: space.md },
});

/** An inline error, boxed so it reads as a distinct state rather than red body text. */
export function ErrorNote({ children }: { children: ReactNode }) {
  return (
    <View style={errorStyles.box}>
      <Text style={errorStyles.text}>{children}</Text>
    </View>
  );
}

const errorStyles = StyleSheet.create({
  box: {
    borderRadius: radius.md,
    backgroundColor: colors.dangerSoft,
    borderLeftWidth: 3,
    borderLeftColor: colors.danger,
    paddingHorizontal: space.lg,
    paddingVertical: space.md,
  },
  text: { color: colors.danger, fontSize: 14, lineHeight: 20 },
});

export function Card({ children, style }: { children: ReactNode; style?: object }) {
  return <View style={StyleSheet.compose(styles.card, style)}>{children}</View>;
}

/**
 * A small pill action — the tier below `ghostButton`, for inline row actions
 * (Edit, Delete, Retry, Save). Every screen that needs one uses this instead of
 * re-declaring its own `minorButton` style, so the small-button vocabulary
 * lives here with the rest of the design system.
 */
export function MiniButton({
  label,
  onPress,
  primary = false,
  disabled = false,
  accessibilityLabel,
}: {
  label: string;
  onPress: () => void;
  primary?: boolean;
  disabled?: boolean;
  accessibilityLabel?: string;
}) {
  return (
    <PressableScale
      testID="household-chat-button"
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      style={StyleSheet.compose(
        primary ? miniStyles.primary : miniStyles.base,
        disabled ? styles.disabled : undefined,
      )}
      disabled={disabled}
      onPress={onPress}
    >
      <Text style={primary ? miniStyles.primaryText : miniStyles.baseText}>{label}</Text>
    </PressableScale>
  );
}

const miniStyles = StyleSheet.create({
  base: {
    borderRadius: radius.pill,
    paddingVertical: 6,
    paddingHorizontal: 13,
    backgroundColor: colors.field,
    minHeight: 34,
    justifyContent: 'center',
  },
  baseText: { color: colors.ink, fontSize: 13, fontWeight: '700' },
  primary: {
    borderRadius: radius.pill,
    paddingVertical: 6,
    paddingHorizontal: 13,
    backgroundColor: colors.accent,
    minHeight: 34,
    justifyContent: 'center',
  },
  primaryText: { color: colors.card, fontSize: 13, fontWeight: '700' },
});

/**
 * A bottom sheet: dimmed scrim (tap to close), a rounded surface that slides up,
 * and a grabber. Every modal surface uses this rather than re-building the
 * overlay/scrim/holder/grabber scaffolding, so a new sheet is just its content.
 */
export function Sheet({
  onClose,
  closeLabel,
  children,
}: {
  onClose: () => void;
  closeLabel: string;
  children: ReactNode;
}) {
  return (
    <View style={sheetStyles.overlay}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={closeLabel}
        style={sheetStyles.scrim}
        onPress={onClose}
      />
      <FadeSlideIn from={40} style={sheetStyles.holder}>
        <View style={sheetStyles.sheet}>
          <View style={sheetStyles.grabber} />
          {children}
        </View>
      </FadeSlideIn>
    </View>
  );
}

const sheetStyles = StyleSheet.create({
  overlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    justifyContent: 'flex-end',
  },
  scrim: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: colors.scrim,
  },
  holder: { width: '100%' },
  sheet: {
    backgroundColor: colors.surface,
    borderTopLeftRadius: radius.xl,
    borderTopRightRadius: radius.xl,
    paddingHorizontal: space.xl,
    paddingTop: space.md,
    paddingBottom: space.xl,
    maxHeight: '88%',
    gap: space.md,
  },
  grabber: {
    alignSelf: 'center',
    width: 40,
    height: 5,
    borderRadius: 3,
    backgroundColor: colors.border,
    marginBottom: space.sm,
  },
});

/**
 * One planned meal: a tinted glyph disc that carries the meal type in colour and
 * shape, the type label, the name, and optional trailing content (a chip, a
 * chevron). Presentational only — the caller supplies the press wrapper and any
 * selection styling — so Today, the Meal Plan, and the conflict sheet all render
 * the same row instead of three hand-copied versions.
 *
 * `meal` is typed structurally so this file keeps importing nothing local.
 */
export function MealRow({
  meal,
  meta,
  trailing,
  style,
}: {
  meal: { mealType: string; name: string };
  meta?: string;
  trailing?: ReactNode;
  style?: ViewStyle | ViewStyle[];
}) {
  const accent = useMemo(() => mealAccent(meal.mealType), [meal.mealType]);
  const glyphStyle = useMemo(() => ({ backgroundColor: accent.tint }), [accent.tint]);
  const typeStyle = useMemo(() => ({ color: accent.label }), [accent.label]);
  return (
    <View style={StyleSheet.compose(mealRowStyles.row, style)}>
      <View style={StyleSheet.compose(mealRowStyles.glyph, glyphStyle)}>
        <Text style={mealRowStyles.glyphText}>{accent.glyph}</Text>
      </View>
      <View style={mealRowStyles.body}>
        <Text style={StyleSheet.compose(styles.mealType, typeStyle)}>{meal.mealType}</Text>
        <Text style={mealRowStyles.name}>{meal.name}</Text>
        {meta ? <Text style={mealRowStyles.meta}>{meta}</Text> : null}
      </View>
      {trailing ? <View style={mealRowStyles.tail}>{trailing}</View> : null}
    </View>
  );
}

const mealRowStyles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: space.lg },
  glyph: {
    width: 52,
    height: 52,
    borderRadius: 26,
    alignItems: 'center',
    justifyContent: 'center',
  },
  glyphText: { fontSize: 25 },
  body: { flex: 1, gap: 3 },
  name: { fontFamily: fonts.display, fontSize: 18, lineHeight: 23, color: colors.ink },
  meta: { fontSize: 12, color: colors.inkSoft },
  tail: { alignItems: 'flex-end', gap: space.xs },
});

// ---------------------------------------------------------------------------
// Loading and empty states
// ---------------------------------------------------------------------------

/**
 * A set of steam-puff driver values, each looping 0→1 on a stagger. Shared by
 * the pot loader and the mascot so the same rising-steam motion is defined once;
 * each caller supplies its own interpolations for position and scale. Pass
 * `enabled: false` (e.g. Reduce Motion) to hold every puff at rest.
 */
export function useSteam(
  count: number,
  {
    enabled = true,
    stagger = 240,
    duration = 1300,
    gap = 0,
  }: {
    enabled?: boolean;
    stagger?: number;
    duration?: number;
    gap?: number;
  } = {},
) {
  const puffs = useRef(Array.from({ length: count }, () => new Animated.Value(0))).current;

  useEffect(() => {
    if (!enabled) return;
    const loops = puffs.map((puff, i) =>
      Animated.loop(
        Animated.sequence([
          Animated.delay(i * stagger),
          Animated.timing(puff, {
            toValue: 1,
            duration,
            easing: Easing.out(Easing.quad),
            useNativeDriver: true,
          }),
          Animated.timing(puff, { toValue: 0, duration: 0, useNativeDriver: true }),
          ...(gap ? [Animated.delay(gap)] : []),
        ]),
      ),
    );
    loops.forEach((l) => l.start());
    return () => loops.forEach((l) => l.stop());
    // puffs are stable useRef handles; only `enabled` (and the timing inputs)
    // can change what the loops should do.
  }, [enabled, stagger, duration, gap, puffs]);

  return puffs;
}

/**
 * Three steam puffs rising off an imaginary pot. Used instead of a spinner
 * because a spinner reads as "the network is slow" while this reads as
 * "something is cooking" — the same wait, a better story.
 */
export function PotLoader({ label }: { label?: string }) {
  const puffs = useSteam(3);
  const puffEntries = useRef(
    puffs.map((puff, index) => ({ key: `steam-puff-${index}`, puff })),
  ).current;

  return (
    <View style={loaderStyles.wrap}>
      <View style={loaderStyles.steamRow}>
        {puffEntries.map(({ key, puff }) => (
          <SteamPuff key={key} puff={puff} />
        ))}
      </View>
      <View style={loaderStyles.pot}>
        <View style={loaderStyles.potRim} />
      </View>
      {label ? <Text style={loaderStyles.label}>{label}</Text> : null}
    </View>
  );
}

function SteamPuff({ puff }: { puff: Animated.Value }) {
  const animatedStyle = useMemo(
    () => ({
      opacity: puff.interpolate({
        inputRange: [0, 0.2, 0.8, 1],
        outputRange: [0, 0.9, 0.5, 0],
      }),
      transform: [
        { translateY: puff.interpolate({ inputRange: [0, 1], outputRange: [6, -18] }) },
        { scale: puff.interpolate({ inputRange: [0, 1], outputRange: [0.6, 1.3] }) },
      ],
    }),
    [puff],
  );

  return <Animated.View style={StyleSheet.compose(loaderStyles.puff, animatedStyle)} />;
}

const loaderStyles = StyleSheet.create({
  wrap: { alignItems: 'center', gap: space.sm, paddingVertical: space.xl },
  steamRow: { flexDirection: 'row', gap: 7, height: 26, alignItems: 'flex-end' },
  puff: { width: 8, height: 8, borderRadius: 4, backgroundColor: colors.accentSoft },
  pot: {
    width: 46,
    height: 28,
    borderBottomLeftRadius: 16,
    borderBottomRightRadius: 16,
    backgroundColor: colors.accent,
    alignItems: 'center',
  },
  potRim: { width: 54, height: 6, borderRadius: 3, backgroundColor: colors.brand, marginTop: -3 },
  label: { fontSize: 14, color: colors.inkSoft, marginTop: space.xs },
});

export function Loading({ label }: { label?: string }) {
  return (
    <View style={styles.centerScreen}>
      <PotLoader label={label} />
    </View>
  );
}

export function Message({ title, body }: { title: string; body: string }) {
  return (
    <View style={styles.centerScreen}>
      <FadeSlideIn>
        <View style={buildingBlockStyles.message}>
          <Text style={styles.title}>{title}</Text>
          <Text style={styles.subtitle}>{body}</Text>
        </View>
      </FadeSlideIn>
    </View>
  );
}

// ---------------------------------------------------------------------------
// Tab bar
// ---------------------------------------------------------------------------

export type TabKey =
  'today' | 'mealPlan' | 'groceries' | 'chat' | 'archive' | 'cookbook' | 'household';
export type IconName =
  'plate' | 'calendar' | 'basket' | 'chat' | 'home' | 'book' | 'search' | 'bookmark' | 'user';

export interface TabSpec {
  key: TabKey;
  label: string;
  icon: IconName;
  /** What this destination renders. Carrying it on the spec means a shell maps
   *  tab → screen by lookup instead of a positional ternary that can render the
   *  wrong screen for a key it does not list. */
  render?: () => ReactNode;
}

type PlatformSymbol = SymbolViewProps['name'];

const tabSymbols: Record<IconName, { regular: PlatformSymbol; selected: PlatformSymbol }> = {
  home: {
    regular: { ios: 'house', android: 'home' },
    selected: { ios: 'house.fill', android: 'home_filled' },
  },
  book: {
    regular: { ios: 'book.closed', android: 'menu_book' },
    selected: { ios: 'book.closed.fill', android: 'menu_book' },
  },
  search: {
    regular: { ios: 'magnifyingglass', android: 'search' },
    selected: { ios: 'magnifyingglass', android: 'search' },
  },
  bookmark: {
    regular: { ios: 'bookmark', android: 'bookmark_border' },
    selected: { ios: 'bookmark.fill', android: 'bookmark' },
  },
  user: {
    regular: { ios: 'person', android: 'person_outline' },
    selected: { ios: 'person.fill', android: 'person' },
  },
  plate: {
    regular: { ios: 'fork.knife', android: 'restaurant' },
    selected: { ios: 'fork.knife', android: 'restaurant' },
  },
  calendar: {
    regular: { ios: 'calendar', android: 'calendar_today' },
    selected: { ios: 'calendar', android: 'calendar_month' },
  },
  basket: {
    regular: { ios: 'basket', android: 'shopping_basket' },
    selected: { ios: 'basket.fill', android: 'shopping_basket' },
  },
  chat: {
    regular: { ios: 'bubble.left', android: 'chat_bubble_outline' },
    selected: { ios: 'bubble.left.fill', android: 'chat_bubble' },
  },
};

/** Native SF Symbols on Apple platforms with matching Material Symbols elsewhere. */
export function TabIcon({
  name,
  color,
  selected = false,
}: {
  name: IconName;
  color: string;
  selected?: boolean;
}) {
  return (
    <SymbolView
      name={tabSymbols[name][selected ? 'selected' : 'regular']}
      size={ICON_SIZE}
      weight={selected ? 'semibold' : 'regular'}
      tintColor={color}
      resizeMode="scaleAspectFit"
      style={tabStyles.symbol}
    />
  );
}

/**
 * Bar geometry. Every animated dimension is declared here rather than derived
 * from layout, so the shrink runs entirely on the UI thread — a layout callback
 * would always lag a frame behind the gesture.
 */
const BAR_EXPANDED = 58;
const BAR_MINIMIZED = 44;
/** Extra horizontal inset applied to the pill per side when minimized. */
const MINIMIZED_INSET = 34;
/** Outer margin between the pill and the screen edges, per side. */
const BAR_MARGIN = 12;
/** Inner inset between the capsule wall and the tab items. */
const ROW_PAD_H = 4;
const ICON_SIZE = 22;
const ITEM_GAP = 1;
/** Label height plus its gap, folded together so it vanishes as one block. */
const LABEL_BLOCK = 12 + ITEM_GAP;
const ITEM_PAD_V = 7;
const PILL_EXPANDED = ICON_SIZE + LABEL_BLOCK + ITEM_PAD_V * 2;
const PILL_MINIMIZED = ICON_SIZE + ITEM_PAD_V * 2;
/** How far the bottom progressive blur rises above the floating capsule. */
const BLUR_BLEED = 44;

/**
 * Spring, not timing, for the shrink: scroll direction flips mid-animation all
 * the time, and a spring retargets while keeping its velocity where a curve
 * would restart from zero. Critically damped — the bar animates layout, so any
 * overshoot would visibly wobble the capsule.
 */
const MINIMIZE_SPRING = { duration: 380, dampingRatio: 1 };
/**
 * The travelling highlight is transform-only, so it can afford a little settle.
 * Interruptible by design: rapid tab-hopping retargets without restarting.
 */
const SLIDE_SPRING = { duration: 420, dampingRatio: 0.82 };

type MinimizeState = {
  /** 0 = expanded (icons + labels), 1 = minimized (icons only). */
  progress: SharedValue<number>;
  /** Last requested target, so per-frame scroll never restarts the spring. */
  target: SharedValue<number>;
};

const MinimizeContext = createContext<MinimizeState | null>(null);

/** Wraps a shell so its screens' scrolling can shrink the shell's tab bar. */
export function TabBarMinimizeProvider({ children }: { children: ReactNode }) {
  const progress = useSharedValue(0);
  const target = useSharedValue(0);
  const state = useMemo(() => ({ progress, target }), [progress, target]);
  return <MinimizeContext.Provider value={state}>{children}</MinimizeContext.Provider>;
}

function useMinimizeState(): MinimizeState {
  const shared = useContext(MinimizeContext);
  // The local fallback keeps a screen working when it renders outside a shell
  // (Meal Plan and Groceries are also reachable without a tab bar).
  const progress = useSharedValue(0);
  const target = useSharedValue(0);
  const local = useMemo(() => ({ progress, target }), [progress, target]);
  return shared ?? local;
}

/** Retarget the shrink spring. No-op when already heading to `next`. */
function setMinimized(state: MinimizeState, next: 0 | 1) {
  'worklet';
  if (state.target.value !== next) {
    state.target.value = next;
    state.progress.value = withSpring(next, MINIMIZE_SPRING);
  }
}

/** Revolut-style direction-aware collapse, adapted from expo-glass-tabs (MIT). */
function useMinimizeOnScroll() {
  const state = useMinimizeState();
  const previousY = useSharedValue(0);

  return useAnimatedScrollHandler({
    onScroll: (event) => {
      const maxY = Math.max(event.contentSize.height - event.layoutMeasurement.height, 0);
      const y = Math.min(Math.max(event.contentOffset.y, 0), maxY);
      const dy = y - previousY.value;
      previousY.value = y;

      if (y < 24) setMinimized(state, 0);
      else if (dy > 3) setMinimized(state, 1);
      else if (dy < -3) setMinimized(state, 0);
    },
  });
}

/**
 * How much bottom room a screen must leave so its last row clears the floating
 * bar. Read from the safe-area inset, so it is correct on a notched iPhone and
 * on an Android device with gesture navigation alike.
 */
export function useTabBarClearance(): number {
  const insets = useSafeAreaInsets();
  return Math.max(insets.bottom - 14, 10) + BAR_EXPANDED + space.lg;
}

/**
 * A ScrollView that reserves room for the persistent labelled tab bar. The
 * redesign deliberately keeps primary navigation stable while content moves;
 * people never have to reverse-scroll to recover a destination.
 */
export function TabScrollView({
  contentContainerStyle,
  ...rest
}: React.ComponentProps<typeof Reanimated.ScrollView>) {
  const clearance = useTabBarClearance();
  const onScroll = useMinimizeOnScroll();
  const clearanceStyle = useMemo(() => ({ paddingBottom: clearance }), [clearance]);
  const contentStyle = useMemo(
    () => [contentContainerStyle, clearanceStyle],
    [clearanceStyle, contentContainerStyle],
  );

  return (
    <Reanimated.ScrollView
      {...rest}
      onScroll={onScroll}
      scrollEventThrottle={16}
      contentContainerStyle={contentStyle}
    />
  );
}

/**
 * A soft stack of native blurs hides the hard edge that a single BlurView
 * creates. The light tint keeps Cooklink's warm paper palette intact.
 */
const blurLayerHeights = [
  '100%',
  '88%',
  '76%',
  '64%',
  '54%',
  '44%',
  '36%',
  '28%',
  '22%',
  '16%',
] as const;
const blurLayers = blurLayerHeights.map((height) => ({
  height,
  style: { height, bottom: 0 } satisfies ViewStyle,
}));

const BottomProgressiveBlur = memo(function BottomProgressiveBlur({ height }: { height: number }) {
  const blurStyle = useMemo(() => ({ height }), [height]);
  return (
    <View pointerEvents="none" style={StyleSheet.compose(tabStyles.blur, blurStyle)}>
      {blurLayers.map((layer) => (
        <BlurView
          key={layer.height}
          tint="light"
          intensity={3}
          style={StyleSheet.compose(tabStyles.blurLayer, layer.style)}
        />
      ))}
      <View style={tabStyles.blurWash} />
    </View>
  );
});

type BarContextValue = {
  /** Fractional tab index the highlight currently sits at. */
  slideIndex: SharedValue<number>;
  isDragging: SharedValue<boolean>;
};

const BarContext = createContext<BarContextValue | null>(null);

/**
 * The persistent three-destination bottom bar (issue 03 — Variant A). Each tab
 * is icon-plus-text and meets the touch-target floor. The bar shows exactly
 * three labelled choices; Household Chat is never a fourth tab.
 *
 * It is a floating capsule rather than an edge-to-edge bar. One shared
 * highlight physically travels between tabs instead of fading in and out, and
 * dragging along the bar scrubs through the tabs, committing on release.
 *
 * Reanimated and Gesture Handler own the motion while Expo Symbols supplies
 * native SF Symbols on Apple platforms and matching Material Symbols elsewhere.
 */
export function BottomTabs({
  tabs,
  active,
  onSelect,
  iconOnly = false,
}: {
  tabs: readonly TabSpec[];
  active: TabKey;
  onSelect: (key: TabKey) => void;
  iconOnly?: boolean;
}) {
  const insets = useSafeAreaInsets();
  const { width: windowWidth } = useWindowDimensions();
  const minimize = useMinimizeState();
  const progress = minimize.progress;
  const slideIndex = useSharedValue(0);
  const isDragging = useSharedValue(false);
  const lastTicked = useSharedValue(-1);
  const tabCount = Math.max(tabs.length, 1);

  const tick = useCallback(() => {
    if (Platform.OS === 'ios') void Haptics.selectionAsync();
  }, []);

  const selectIndex = useCallback(
    (index: number) => {
      const tab = tabs[index];
      if (tab) onSelect(tab.key);
    },
    [tabs, onSelect],
  );

  // Scrubbing: the highlight tracks the finger 1:1 while dragging (no spring —
  // it has to feel attached) and navigation happens only on release, because
  // switching screens mid-drag makes the content jump under the finger. A tap
  // gesture races the pan; the detector consumes the bar's touches, so the
  // inner Pressables only ever fire for assistive activation.
  const gesture = useMemo(() => {
    const indexAtX = (x: number, minimized: number) => {
      'worklet';
      const sideInset = interpolate(minimized, [0, 1], [0, MINIMIZED_INSET], Extrapolation.CLAMP);
      const barWidth = windowWidth - BAR_MARGIN * 2 - sideInset * 2;
      const itemWidth = (barWidth - ROW_PAD_H * 2) / tabCount;
      const raw = (x - ROW_PAD_H) / itemWidth - 0.5;
      return Math.min(Math.max(raw, 0), tabCount - 1);
    };

    const pan = Gesture.Pan()
      .activeOffsetX([-6, 6])
      .failOffsetY([-14, 14])
      .onStart(() => {
        isDragging.value = true;
        lastTicked.value = Math.round(slideIndex.value);
        // Scrubbing is a deliberate bar interaction — bring the labels back.
        setMinimized(minimize, 0);
      })
      .onUpdate((event) => {
        const index = indexAtX(event.x, progress.value);
        slideIndex.value = index;
        const rounded = Math.round(index);
        if (rounded !== lastTicked.value) {
          lastTicked.value = rounded;
          runOnJS(tick)();
        }
      })
      .onFinalize(() => {
        // Fires on failure too (the touch was a tap) — only act when the pan
        // actually activated, or this would stomp the tap's navigation.
        if (!isDragging.value) return;
        const rounded = Math.round(slideIndex.value);
        slideIndex.value = withSpring(rounded, SLIDE_SPRING);
        runOnJS(selectIndex)(rounded);
        isDragging.value = false;
      });

    const tap = Gesture.Tap()
      // Real fingers drift a few points; the default ~2pt tolerance makes
      // ordinary taps fail. Past 6pt horizontal the pan takes over anyway.
      .maxDistance(16)
      .maxDuration(400)
      .onEnd((event, success) => {
        if (!success) return;
        const index = Math.round(indexAtX(event.x, progress.value));
        slideIndex.value = withSpring(index, SLIDE_SPRING);
        setMinimized(minimize, 0);
        runOnJS(selectIndex)(index);
      });

    return Gesture.Race(pan, tap);
  }, [
    windowWidth,
    tabCount,
    selectIndex,
    tick,
    isDragging,
    lastTicked,
    slideIndex,
    minimize,
    progress,
  ]);

  const barStyle = useAnimatedStyle(() => {
    const height = interpolate(
      progress.value,
      [0, 1],
      [BAR_EXPANDED, BAR_MINIMIZED],
      Extrapolation.CLAMP,
    );
    return {
      height,
      // The capsule shrinks in both dimensions, not just in height.
      marginHorizontal: interpolate(
        progress.value,
        [0, 1],
        [0, MINIMIZED_INSET],
        Extrapolation.CLAMP,
      ),
    };
  });

  const shapeStyle = useAnimatedStyle(() => {
    const height = interpolate(
      progress.value,
      [0, 1],
      [BAR_EXPANDED, BAR_MINIMIZED],
      Extrapolation.CLAMP,
    );
    return { borderRadius: height / 2 };
  });

  // One shared highlight that slides between tabs, transform-only so it stays
  // on the GPU. All geometry derives from shared values, never from layout.
  const highlightStyle = useAnimatedStyle(() => {
    const barHeight = interpolate(
      progress.value,
      [0, 1],
      [BAR_EXPANDED, BAR_MINIMIZED],
      Extrapolation.CLAMP,
    );
    const height = interpolate(
      progress.value,
      [0, 1],
      [PILL_EXPANDED, PILL_MINIMIZED],
      Extrapolation.CLAMP,
    );
    const sideInset = interpolate(
      progress.value,
      [0, 1],
      [0, MINIMIZED_INSET],
      Extrapolation.CLAMP,
    );
    const itemWidth = (windowWidth - BAR_MARGIN * 2 - sideInset * 2 - ROW_PAD_H * 2) / tabCount;
    return {
      height,
      width: itemWidth,
      borderRadius: height / 2,
      top: (barHeight - height) / 2,
      transform: [{ translateX: ROW_PAD_H + itemWidth * slideIndex.value }],
    };
  });

  const barContext = useMemo(() => ({ slideIndex, isDragging }), [slideIndex, isDragging]);
  const bottomOffset = Math.max(insets.bottom - 14, 10);
  const dockInsetStyle = useMemo(
    () => ({ marginHorizontal: BAR_MARGIN, marginBottom: bottomOffset }),
    [bottomOffset],
  );
  const composedBarStyle = useMemo(() => [tabStyles.bar, barStyle], [barStyle]);
  const composedMaterialStyle = useMemo(() => [tabStyles.material, shapeStyle], [shapeStyle]);
  const composedFallbackStyle = useMemo(
    () => [tabStyles.material, tabStyles.fallback, shapeStyle],
    [shapeStyle],
  );
  const composedHighlightStyle = useMemo(() => [tabStyles.pill, highlightStyle], [highlightStyle]);

  return (
    <View pointerEvents="box-none" style={tabStyles.dock}>
      <BottomProgressiveBlur height={bottomOffset + BAR_EXPANDED + BLUR_BLEED} />
      <View pointerEvents="box-none" style={dockInsetStyle}>
        <GestureDetector gesture={gesture}>
          <Reanimated.View style={composedBarStyle}>
            {isLiquidGlassAvailable() ? (
              <AnimatedGlassView glassEffectStyle="regular" style={composedMaterialStyle} />
            ) : (
              <Reanimated.View style={composedFallbackStyle} />
            )}
            <Reanimated.View style={composedHighlightStyle} />
            <View style={tabStyles.row}>
              <BarContext.Provider value={barContext}>
                {tabs.map((tab, index) => (
                  <TabButton
                    key={tab.key}
                    tab={tab}
                    index={index}
                    isActive={tab.key === active}
                    onSelect={onSelect}
                    iconOnly={iconOnly}
                  />
                ))}
              </BarContext.Provider>
            </View>
          </Reanimated.View>
        </GestureDetector>
      </View>
    </View>
  );
}

const TabButton = memo(function TabButton({
  tab,
  index,
  isActive,
  onSelect,
  iconOnly,
}: {
  tab: TabSpec;
  index: number;
  isActive: boolean;
  onSelect: (key: TabKey) => void;
  iconOnly: boolean;
}) {
  const minimize = useMinimizeState();
  const progress = minimize.progress;
  const bar = useContext(BarContext);
  const slideIndex = bar?.slideIndex;
  const onPress = useCallback(() => onSelect(tab.key), [onSelect, tab.key]);
  const accessibilityState = useMemo(() => ({ selected: isActive }), [isActive]);

  // Covers selection that did not come from the bar itself. While scrubbing the
  // finger owns the highlight, so never fight it with a spring.
  useEffect(() => {
    if (isActive && bar && !bar.isDragging.value) {
      bar.slideIndex.value = withSpring(index, SLIDE_SPRING);
    }
  }, [isActive, index, bar]);

  // Tint follows the highlight rather than the selected tab: whatever the pill
  // is over lights up — live while scrubbing, travelling on a tap.
  const distance = (value: number) => {
    'worklet';
    return Math.min(Math.abs(value - index), 1);
  };

  const activeIconStyle = useAnimatedStyle(() => ({
    opacity: slideIndex ? 1 - distance(slideIndex.value) : isActive ? 1 : 0,
  }));

  const inactiveIconStyle = useAnimatedStyle(() => ({
    opacity: slideIndex ? distance(slideIndex.value) : isActive ? 0 : 1,
  }));

  const labelStyle = useAnimatedStyle(() => ({
    opacity: interpolate(progress.value, [0, 0.4], [1, 0], Extrapolation.CLAMP),
    color: slideIndex
      ? interpolateColor(distance(slideIndex.value), [0, 1], [colors.coral, colors.inkSoft])
      : isActive
        ? colors.coral
        : colors.inkSoft,
  }));

  // The height is animated explicitly rather than derived from the children, so
  // the icon stays exactly centred every frame while the label is clipped away.
  const boxStyle = useAnimatedStyle(() => ({
    height: interpolate(
      progress.value,
      [0, 1],
      [PILL_EXPANDED, PILL_MINIMIZED],
      Extrapolation.CLAMP,
    ),
  }));
  const composedBoxStyle = useMemo(() => [tabStyles.box, boxStyle], [boxStyle]);
  const composedInactiveIconStyle = useMemo(
    () => [tabStyles.iconLayer, inactiveIconStyle],
    [inactiveIconStyle],
  );
  const composedActiveIconStyle = useMemo(
    () => [StyleSheet.absoluteFill, tabStyles.iconLayer, activeIconStyle],
    [activeIconStyle],
  );
  const composedLabelStyle = useMemo(() => [tabStyles.label, labelStyle], [labelStyle]);

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={accessibilityState}
      accessibilityLabel={tab.label}
      style={tabStyles.tab}
      // The gesture detector swallows ordinary touches; this still runs for
      // VoiceOver and TalkBack activation, which is the path that matters here.
      onPress={onPress}
    >
      <Reanimated.View style={composedBoxStyle}>
        <View style={tabStyles.iconFrame}>
          <Reanimated.View style={composedInactiveIconStyle}>
            <TabIcon name={tab.icon} color={colors.inkSoft} />
          </Reanimated.View>
          <Reanimated.View style={composedActiveIconStyle}>
            <TabIcon name={tab.icon} color={colors.accent} selected />
          </Reanimated.View>
        </View>
        {!iconOnly ? (
          <Reanimated.Text numberOfLines={1} style={composedLabelStyle}>
            {tab.label}
          </Reanimated.Text>
        ) : null}
      </Reanimated.View>
    </Pressable>
  );
});

const tabStyles = StyleSheet.create({
  dock: { position: 'absolute', left: 0, right: 0, bottom: 0 },
  bar: {
    ...shadow.lift,
  },
  material: {
    position: 'absolute',
    inset: 0,
    backgroundColor: colors.glassMaterial,
    borderCurve: 'continuous',
  },
  fallback: {
    backgroundColor: colors.glassFallback,
    borderWidth: 1,
    borderColor: colors.glassBorder,
  },
  row: { flex: 1, flexDirection: 'row', alignItems: 'center', paddingHorizontal: ROW_PAD_H },
  tab: { flex: 1, minHeight: 44, alignItems: 'center', justifyContent: 'center' },
  box: {
    alignSelf: 'stretch',
    alignItems: 'center',
    paddingTop: ITEM_PAD_V,
    overflow: 'hidden',
  },
  iconFrame: {
    width: ICON_SIZE,
    height: ICON_SIZE,
    alignItems: 'center',
    justifyContent: 'center',
  },
  iconLayer: { alignItems: 'center', justifyContent: 'center' },
  symbol: { width: ICON_SIZE, height: ICON_SIZE },
  pill: {
    position: 'absolute',
    left: 0,
    backgroundColor: colors.glassHighlight,
    borderCurve: 'continuous',
    borderRadius: BAR_EXPANDED / 2,
  },
  label: {
    width: '100%',
    fontFamily: fonts.semibold,
    fontSize: 10,
    lineHeight: 12,
    fontWeight: '400',
    letterSpacing: 0,
    textAlign: 'center',
    includeFontPadding: false,
    marginTop: ITEM_GAP,
  },
  blur: { position: 'absolute', left: 0, right: 0, bottom: 0 },
  blurLayer: { position: 'absolute', left: 0, right: 0 },
  blurWash: {
    position: 'absolute',
    inset: 0,
    experimental_backgroundImage:
      'linear-gradient(to top, rgba(253,252,248,0.96) 0%, rgba(253,252,248,0.54) 42%, rgba(253,252,248,0.12) 70%, rgba(253,252,248,0) 92%)',
  },
});

// ---------------------------------------------------------------------------
// Chat header action
// ---------------------------------------------------------------------------

/**
 * A header action that opens Household Chat (issue 03 — Chat is not a tab).
 * The unread badge pulses once when it appears so a new message is noticed
 * without a sound or a banner.
 */
export function ChatHeaderAction({ unread, onPress }: { unread?: number; onPress: () => void }) {
  const pulse = useRef(new Animated.Value(0)).current;
  const badgeStyle = useMemo(
    () => ({
      transform: [{ scale: pulse.interpolate({ inputRange: [0, 1], outputRange: [1, 1.35] }) }],
    }),
    [pulse],
  );

  useEffect(() => {
    if (!unread) return;
    Animated.sequence([
      Animated.spring(pulse, { toValue: 1, friction: 4, tension: 200, useNativeDriver: true }),
      Animated.spring(pulse, { toValue: 0, ...motion.select }),
    ]).start();
  }, [unread, pulse]);

  return (
    <PressableScale
      accessibilityRole="button"
      accessibilityLabel={`Household Chat${unread ? `, ${unread} unread` : ''}`}
      style={chatStyles.button}
      onPress={onPress}
    >
      <TabIcon name="chat" color={colors.accent} />
      {unread ? (
        <Animated.View style={StyleSheet.compose(chatStyles.badge, badgeStyle)}>
          <Text style={chatStyles.badgeText}>{unread > 9 ? '9+' : unread}</Text>
        </Animated.View>
      ) : null}
    </PressableScale>
  );
}

const chatStyles = StyleSheet.create({
  button: {
    minHeight: 44,
    width: 44,
    borderRadius: 21,
    backgroundColor: colors.card,
    alignItems: 'center',
    justifyContent: 'center',
    ...shadow.soft,
  },
  badge: {
    position: 'absolute',
    top: -2,
    right: -2,
    minWidth: 20,
    height: 20,
    borderRadius: 10,
    paddingHorizontal: 5,
    backgroundColor: colors.danger,
    borderWidth: 2,
    borderColor: colors.card,
    alignItems: 'center',
    justifyContent: 'center',
  },
  badgeText: { color: colors.card, fontSize: 10, fontWeight: '800' },
});
