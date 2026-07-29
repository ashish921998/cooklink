import {
  createContext,
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
  Text,
  View,
  useWindowDimensions,
  type PressableProps,
  type ViewStyle,
} from 'react-native';
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
  // Surfaces, warmest to coolest.
  surface: '#FBF5EC',
  surfaceDeep: '#F3EADB',
  card: '#FFFFFF',
  field: '#EFE7D9',
  border: '#E7DDCB',

  // Text. `ink` and `inkSoft` both clear 4.5:1 on surface and card.
  ink: '#212A26',
  inkSoft: '#63605A',

  // Deep curry-leaf green: every primary action, and white-on-accent text.
  accent: '#0F5D45',
  accentSoft: '#D8E8E0',

  // Cinnamon: eyebrows, day headings, meal-type labels.
  brand: '#8A4A22',
  brandSoft: '#F3E3D3',

  // Warning red, and the two decorative spices (never used behind body text).
  danger: '#A32E1E',
  turmeric: '#E9A63B',
  paprika: '#D9612C',
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

/**
 * The display face is the platform serif — Georgia on iOS, Noto Serif on
 * Android. Both ship with the OS, so the warm editorial voice costs no font
 * files and no bundle weight.
 */
export const fonts = {
  display: Platform.select({ ios: 'Georgia', android: 'serif', default: 'serif' }),
};

export const space = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32 };

export const radius = { sm: 10, md: 16, lg: 22, xl: 28, pill: 999 };

export const shadow = {
  /** Resting cards. */
  soft: {
    shadowColor: '#7A5A32',
    shadowOpacity: 0.1,
    shadowRadius: 18,
    shadowOffset: { width: 0, height: 8 },
    elevation: 3,
  },
  /** Hero cards, sheets, and the tab bar. */
  lift: {
    shadowColor: '#6B4E2C',
    shadowOpacity: 0.16,
    shadowRadius: 28,
    shadowOffset: { width: 0, height: 14 },
    elevation: 10,
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
}: PressableProps & { children: ReactNode; style?: ViewStyle | ViewStyle[]; to?: number }) {
  const scale = useRef(new Animated.Value(1)).current;
  const spring = (value: number) =>
    Animated.spring(scale, { toValue: value, ...motion.press }).start();

  return (
    <AnimatedPressable
      {...rest}
      style={[style, { transform: [{ scale }] }]}
      onPressIn={(e) => {
        spring(to);
        rest.onPressIn?.(e);
      }}
      onPressOut={(e) => {
        spring(1);
        rest.onPressOut?.(e);
      }}
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

  useEffect(() => {
    Animated.timing(progress, {
      toValue: 1,
      duration: motion.enterMs,
      delay,
      easing: motion.easeOut,
      useNativeDriver: true,
    }).start();
  }, [delay, progress]);

  return (
    <Animated.View
      style={[
        style,
        {
          opacity: progress,
          transform: [
            { translateY: progress.interpolate({ inputRange: [0, 1], outputRange: [from, 0] }) },
          ],
        },
      ]}
    >
      {children}
    </Animated.View>
  );
}

// ---------------------------------------------------------------------------
// Core styles
// ---------------------------------------------------------------------------

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
    borderRadius: radius.pill,
    backgroundColor: colors.accent,
    alignItems: 'center',
    justifyContent: 'center',
    ...shadow.soft,
  },
  primaryButtonText: { color: '#FFFFFF', fontSize: 17, fontWeight: '700', letterSpacing: 0.2 },
  secondaryButton: {
    padding: 15,
    paddingHorizontal: space.xl,
    borderRadius: radius.pill,
    backgroundColor: colors.ink,
    alignItems: 'center',
    justifyContent: 'center',
  },
  secondaryButtonText: { color: '#FFFFFF', fontSize: 16, fontWeight: '700' },
  /** Outline rather than filled, so it never competes with the primary pill. */
  ghostButton: {
    padding: 14,
    paddingHorizontal: 18,
    borderRadius: radius.pill,
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
  return (
    <View style={[chipStyles.chip, { backgroundColor: tint }]}>
      <Text style={[chipStyles.text, { color: ink }]}>{label}</Text>
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
  return (
    <View style={[avatarStyles.circle, { width: size, height: size, borderRadius: size / 2 }]}>
      <Text style={[avatarStyles.text, { fontSize: size * 0.42 }]}>{initial}</Text>
    </View>
  );
}

const avatarStyles = StyleSheet.create({
  circle: { backgroundColor: colors.accentSoft, alignItems: 'center', justifyContent: 'center' },
  text: { fontFamily: fonts.display, fontWeight: '700', color: colors.accent },
});

export function Divider() {
  return <View style={{ height: 1, backgroundColor: colors.border }} />;
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
    <View style={{ gap: space.sm }}>
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
    backgroundColor: '#FBEAE6',
    borderLeftWidth: 3,
    borderLeftColor: colors.danger,
    paddingHorizontal: space.lg,
    paddingVertical: space.md,
  },
  text: { color: colors.danger, fontSize: 14, lineHeight: 20 },
});

export function Card({ children, style }: { children: ReactNode; style?: object }) {
  return <View style={[styles.card, style]}>{children}</View>;
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
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      style={[primary ? miniStyles.primary : miniStyles.base, disabled && styles.disabled]}
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
  primaryText: { color: '#FFFFFF', fontSize: 13, fontWeight: '700' },
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
    backgroundColor: 'rgba(28,20,12,0.45)',
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
  const accent = mealAccent(meal.mealType);
  return (
    <View style={[mealRowStyles.row, style]}>
      <View style={[mealRowStyles.glyph, { backgroundColor: accent.tint }]}>
        <Text style={mealRowStyles.glyphText}>{accent.glyph}</Text>
      </View>
      <View style={mealRowStyles.body}>
        <Text style={[styles.mealType, { color: accent.label }]}>{meal.mealType}</Text>
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

  return (
    <View style={loaderStyles.wrap}>
      <View style={loaderStyles.steamRow}>
        {puffs.map((puff, i) => (
          <Animated.View
            key={i}
            style={[
              loaderStyles.puff,
              {
                opacity: puff.interpolate({
                  inputRange: [0, 0.2, 0.8, 1],
                  outputRange: [0, 0.9, 0.5, 0],
                }),
                transform: [
                  { translateY: puff.interpolate({ inputRange: [0, 1], outputRange: [6, -18] }) },
                  { scale: puff.interpolate({ inputRange: [0, 1], outputRange: [0.6, 1.3] }) },
                ],
              },
            ]}
          />
        ))}
      </View>
      <View style={loaderStyles.pot}>
        <View style={loaderStyles.potRim} />
      </View>
      {label ? <Text style={loaderStyles.label}>{label}</Text> : null}
    </View>
  );
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
        <View style={{ gap: space.md }}>
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

export type TabKey = 'today' | 'mealPlan' | 'groceries' | 'chat';
export type IconName = 'plate' | 'calendar' | 'basket' | 'chat';

export interface TabSpec {
  key: TabKey;
  label: string;
  icon: IconName;
  /** What this destination renders. Carrying it on the spec means a shell maps
   *  tab → screen by lookup instead of a positional ternary that can render the
   *  wrong screen for a key it does not list. */
  render?: () => ReactNode;
}

/**
 * Tab icons drawn from plain Views rather than an icon font. Four shapes is
 * less code than a font dependency, and they inherit the palette exactly.
 */
export function TabIcon({ name, color }: { name: IconName; color: string }) {
  if (name === 'plate') {
    // A bowl with a rim, rather than a ring — it reads as food at 22pt where a
    // circle reads as a generic target.
    return (
      <View style={iconStyles.plateWrap}>
        <View style={[iconStyles.plateRim, { backgroundColor: color }]} />
        <View style={[iconStyles.plate, { borderColor: color }]} />
      </View>
    );
  }
  if (name === 'calendar') {
    return (
      <View style={[iconStyles.calendar, { borderColor: color }]}>
        <View style={[iconStyles.calendarBar, { backgroundColor: color }]} />
        <View style={iconStyles.calendarDots}>
          <View style={[iconStyles.dot, { backgroundColor: color }]} />
          <View style={[iconStyles.dot, { backgroundColor: color }]} />
        </View>
      </View>
    );
  }
  if (name === 'basket') {
    return (
      <View style={iconStyles.basketWrap}>
        <View style={[iconStyles.basketHandle, { borderColor: color }]} />
        <View style={[iconStyles.basket, { borderColor: color }]}>
          <View style={[iconStyles.basketRib, { backgroundColor: color }]} />
        </View>
      </View>
    );
  }
  return (
    <View style={iconStyles.chatWrap}>
      <View style={[iconStyles.chatBubble, { backgroundColor: color }]} />
      <View style={[iconStyles.chatTail, { borderTopColor: color }]} />
    </View>
  );
}

const iconStyles = StyleSheet.create({
  plateWrap: { width: 22, height: 22, alignItems: 'center', justifyContent: 'center', gap: 2 },
  plateRim: { width: 21, height: 2, borderRadius: 1 },
  plate: {
    width: 18,
    height: 10,
    borderWidth: 2,
    borderTopWidth: 0,
    borderBottomLeftRadius: 10,
    borderBottomRightRadius: 10,
  },
  calendar: {
    width: 22,
    height: 21,
    borderRadius: 6,
    borderWidth: 2,
    paddingTop: 3,
    alignItems: 'center',
    gap: 3,
  },
  calendarBar: { width: 10, height: 2, borderRadius: 1 },
  calendarDots: { flexDirection: 'row', gap: 3 },
  dot: { width: 3, height: 3, borderRadius: 1.5 },
  basketWrap: {
    width: 22,
    height: 22,
    alignItems: 'center',
    justifyContent: 'flex-end',
    paddingBottom: 1,
  },
  basketHandle: {
    width: 11,
    height: 7,
    borderWidth: 2,
    borderBottomWidth: 0,
    borderTopLeftRadius: 6,
    borderTopRightRadius: 6,
    marginBottom: 1,
  },
  basket: {
    width: 21,
    height: 12,
    borderWidth: 2,
    borderBottomLeftRadius: 8,
    borderBottomRightRadius: 8,
    borderTopLeftRadius: 3,
    borderTopRightRadius: 3,
    alignItems: 'center',
    paddingTop: 2,
  },
  basketRib: { width: 2, height: 5, borderRadius: 1 },
  chatWrap: { width: 22, height: 22, alignItems: 'flex-start', justifyContent: 'center' },
  chatBubble: { width: 21, height: 16, borderRadius: 6 },
  chatTail: {
    width: 0,
    height: 0,
    marginLeft: 4,
    borderTopWidth: 6,
    borderRightWidth: 7,
    borderRightColor: 'transparent',
  },
});

/**
 * Bar geometry. Every animated dimension is declared here rather than derived
 * from layout, so the shrink runs entirely on the UI thread — a layout callback
 * would always lag a frame behind the gesture.
 */
const BAR_EXPANDED = 60;
const BAR_MINIMIZED = 44;
/** Extra horizontal inset applied to the pill per side when minimized. */
const MINIMIZED_INSET = 34;
/** Outer margin between the pill and the screen edges, per side. */
const BAR_MARGIN = 12;
/** Inner inset between the capsule wall and the tab items. */
const ROW_PAD_H = 4;
const ICON_SIZE = 22;
const ITEM_GAP = 2;
/** Label height plus its gap, folded together so it vanishes as one block. */
const LABEL_BLOCK = 14 + ITEM_GAP;
const ITEM_PAD_V = 7;
const PILL_EXPANDED = ICON_SIZE + LABEL_BLOCK + ITEM_PAD_V * 2;
const PILL_MINIMIZED = ICON_SIZE + ITEM_PAD_V * 2;

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

/**
 * How much bottom room a screen must leave so its last row clears the floating
 * bar. Read from the safe-area inset, so it is correct on a notched iPhone and
 * on an Android device with gesture navigation alike.
 */
export function useTabBarClearance(): number {
  const insets = useSafeAreaInsets();
  return Math.max(insets.bottom - 16, 12) + BAR_EXPANDED + space.lg;
}

/**
 * A ScrollView that shrinks the shell's tab bar as you scroll down and restores
 * it on the way back up, and reserves room for the floating bar. Screens inside
 * a tab shell use this in place of ScrollView; the scroll position is read on
 * the UI thread, so the bar keeps up with a fast flick.
 */
export function TabScrollView({
  contentContainerStyle,
  ...rest
}: React.ComponentProps<typeof Reanimated.ScrollView>) {
  const state = useMinimizeState();
  const previousY = useSharedValue(0);
  const clearance = useTabBarClearance();

  const onScroll = useAnimatedScrollHandler({
    onScroll: (event) => {
      // Clamp to the scrollable range so rubber-band overscroll cannot flip the
      // direction for a frame and flicker the bar.
      const maxY = Math.max(event.contentSize.height - event.layoutMeasurement.height, 0);
      const y = Math.min(Math.max(event.contentOffset.y, 0), maxY);
      const dy = y - previousY.value;
      previousY.value = y;

      if (y < 24) setMinimized(state, 0);
      else if (dy > 3) setMinimized(state, 1);
      else if (dy < -3) setMinimized(state, 0);
    },
  });

  return (
    <Reanimated.ScrollView
      {...rest}
      onScroll={onScroll}
      scrollEventThrottle={16}
      contentContainerStyle={[contentContainerStyle, { paddingBottom: clearance }]}
    />
  );
}

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
 * It is a floating capsule rather than an edge-to-edge bar: it shrinks in both
 * dimensions while the content scrolls away under it, one shared highlight
 * physically travels between tabs instead of fading in and out, and dragging
 * along the bar scrubs through the tabs, committing on release.
 *
 * Deliberately built from Reanimated and Gesture Handler alone — no SF Symbols
 * and no liquid glass — because both are iOS-only and would leave the Android
 * bar visibly different (SymbolView renders nothing at all there).
 */
export function BottomTabs({
  tabs,
  active,
  onSelect,
}: {
  tabs: readonly TabSpec[];
  active: TabKey;
  onSelect: (key: TabKey) => void;
}) {
  const insets = useSafeAreaInsets();
  const { width: windowWidth } = useWindowDimensions();
  const minimize = useMinimizeState();
  const progress = minimize.progress;
  const slideIndex = useSharedValue(0);
  const isDragging = useSharedValue(false);
  const lastTicked = useSharedValue(-1);
  const tabCount = Math.max(tabs.length, 1);

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
        slideIndex.value = indexAtX(event.x, progress.value);
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
  }, [windowWidth, tabCount, selectIndex, isDragging, lastTicked, slideIndex, minimize, progress]);

  const barStyle = useAnimatedStyle(() => {
    const height = interpolate(
      progress.value,
      [0, 1],
      [BAR_EXPANDED, BAR_MINIMIZED],
      Extrapolation.CLAMP,
    );
    return {
      height,
      borderRadius: height / 2,
      // The capsule shrinks in both dimensions, not just in height.
      marginHorizontal: interpolate(
        progress.value,
        [0, 1],
        [0, MINIMIZED_INSET],
        Extrapolation.CLAMP,
      ),
    };
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
  const bottomOffset = Math.max(insets.bottom - 16, 12);

  return (
    <View
      pointerEvents="box-none"
      style={[tabStyles.dock, { marginHorizontal: BAR_MARGIN, marginBottom: bottomOffset }]}
    >
      <GestureDetector gesture={gesture}>
        <Reanimated.View style={[tabStyles.bar, barStyle]}>
          <Reanimated.View style={[tabStyles.pill, highlightStyle]} />
          <View style={tabStyles.row}>
            <BarContext.Provider value={barContext}>
              {tabs.map((tab, index) => (
                <TabButton
                  key={tab.key}
                  tab={tab}
                  index={index}
                  isActive={tab.key === active}
                  onPress={() => onSelect(tab.key)}
                />
              ))}
            </BarContext.Provider>
          </View>
        </Reanimated.View>
      </GestureDetector>
    </View>
  );
}

function TabButton({
  tab,
  index,
  isActive,
  onPress,
}: {
  tab: TabSpec;
  index: number;
  isActive: boolean;
  onPress: () => void;
}) {
  const minimize = useMinimizeState();
  const progress = minimize.progress;
  const bar = useContext(BarContext);
  const slideIndex = bar?.slideIndex;

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

  const labelStyle = useAnimatedStyle(() => ({
    opacity: interpolate(progress.value, [0, 0.4], [1, 0], Extrapolation.CLAMP),
    color: slideIndex
      ? interpolateColor(distance(slideIndex.value), [0, 1], [colors.accent, colors.inkSoft])
      : isActive
        ? colors.accent
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

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected: isActive }}
      accessibilityLabel={tab.label}
      style={tabStyles.tab}
      // The gesture detector swallows ordinary touches; this still runs for
      // VoiceOver and TalkBack activation, which is the path that matters here.
      onPress={onPress}
    >
      <Reanimated.View style={[tabStyles.box, boxStyle]}>
        <View>
          <TabIcon name={tab.icon} color={colors.inkSoft} />
          <Reanimated.View style={[StyleSheet.absoluteFill, activeIconStyle]}>
            <TabIcon name={tab.icon} color={colors.accent} />
          </Reanimated.View>
        </View>
        <Reanimated.Text numberOfLines={1} style={[tabStyles.label, labelStyle]}>
          {tab.label}
        </Reanimated.Text>
      </Reanimated.View>
    </Pressable>
  );
}

const tabStyles = StyleSheet.create({
  dock: { position: 'absolute', left: 0, right: 0, bottom: 0 },
  bar: {
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.border,
    borderCurve: 'continuous',
    ...shadow.lift,
  },
  row: { flex: 1, flexDirection: 'row', alignItems: 'center', paddingHorizontal: ROW_PAD_H },
  tab: { flex: 1, minHeight: 44, alignItems: 'center', justifyContent: 'center' },
  box: {
    alignSelf: 'stretch',
    alignItems: 'center',
    paddingTop: ITEM_PAD_V,
    overflow: 'hidden',
  },
  pill: {
    position: 'absolute',
    left: 0,
    backgroundColor: colors.accentSoft,
    borderCurve: 'continuous',
  },
  label: {
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 0.2,
    marginTop: ITEM_GAP,
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
        <Animated.View
          style={[
            chatStyles.badge,
            {
              transform: [
                { scale: pulse.interpolate({ inputRange: [0, 1], outputRange: [1, 1.35] }) },
              ],
            },
          ]}
        >
          <Text style={chatStyles.badgeText}>{unread > 9 ? '9+' : unread}</Text>
        </Animated.View>
      ) : null}
    </PressableScale>
  );
}

const chatStyles = StyleSheet.create({
  button: {
    minHeight: 46,
    width: 46,
    borderRadius: 23,
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
  badgeText: { color: '#FFFFFF', fontSize: 10, fontWeight: '800' },
});
