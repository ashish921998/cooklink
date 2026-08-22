import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AccessibilityInfo, Animated, Easing, Pressable, StyleSheet, View } from 'react-native';
import { colors, fonts, radius, shadow, space, useSteam } from './design-system';
import { Text } from './Typography';

/**
 * Chotu and Masala — Cooklink's house characters.
 *
 * Chotu is the cook: toque, moustache, green apron. Masala is the kitchen cat
 * who peers around his leg. They exist to give the product a face in the three
 * places a household feels most uncertain — first launch, an empty household,
 * and the wait while a week of meals is generated.
 *
 * Both are composed entirely from Views. That is deliberate: it keeps the
 * character in the palette defined by `ui.tsx`, needs no SVG or image asset,
 * and animates on the native driver like any other view. The nominal drawing
 * is 140x136 and the whole figure is scaled from there, so one set of numbers
 * serves every size it appears at.
 *
 * Motion is suppressed entirely when the platform reports Reduce Motion, in
 * which case Chotu simply stands still.
 */

// Character palette, kept local so it never leaks into the app's semantic
// colour tokens (or the accessibility test's colour parser).
const skin = '#E5AD7B';
const skinShade = '#D4996A';
const toque = '#FFFDF8';
const toqueShade = '#EFE7D8';
const hair = '#3A2A1E';
const apron = colors.accent;
const apronDark = '#0B4834';
const blush = '#E88F6E';
const ginger = '#D08A4A';
const gingerDark = '#B06F35';
const transparent = 'transparent';

const DRAWING_WIDTH = 140;
const DRAWING_HEIGHT = 136;

const LINES = ['Namaste!', 'Kya banana hai?', 'Chai first?', 'Sab taiyaar hai!'];
const PUFF_CONFIG = [
  { id: 'left', offset: -3 },
  { id: 'center', offset: 3 },
  { id: 'right', offset: -3 },
] as const;

export function Mascot({
  size = DRAWING_WIDTH,
  say,
  withPet = true,
  interactive = true,
}: {
  /** Rendered width in points; the figure scales proportionally. */
  size?: number;
  /** A persistent speech bubble. Omit to show one only on tap. */
  say?: string;
  withPet?: boolean;
  interactive?: boolean;
}) {
  const scale = size / DRAWING_WIDTH;
  const [reduceMotion, setReduceMotion] = useState(false);
  const [tapLine, setTapLine] = useState<string | null>(null);

  const bob = useRef(new Animated.Value(0)).current;
  const blink = useRef(new Animated.Value(1)).current;
  const tail = useRef(new Animated.Value(0)).current;
  const jump = useRef(new Animated.Value(0)).current;
  const bubble = useRef(new Animated.Value(say ? 1 : 0)).current;
  const puffs = useSteam(3, { enabled: !reduceMotion, stagger: 500, duration: 2000, gap: 500 });

  useEffect(() => {
    let cancelled = false;
    void AccessibilityInfo.isReduceMotionEnabled().then((on) => {
      if (!cancelled) setReduceMotion(on);
    });
    const sub = AccessibilityInfo.addEventListener('reduceMotionChanged', setReduceMotion);
    return () => {
      cancelled = true;
      sub.remove();
    };
  }, []);

  // Idle life: a slow breath, an occasional blink, a flicking tail, and steam.
  useEffect(() => {
    if (reduceMotion) return;

    const breathe = Animated.loop(
      Animated.sequence([
        Animated.timing(bob, {
          toValue: 1,
          duration: 1600,
          easing: Easing.inOut(Easing.sin),
          useNativeDriver: true,
        }),
        Animated.timing(bob, {
          toValue: 0,
          duration: 1600,
          easing: Easing.inOut(Easing.sin),
          useNativeDriver: true,
        }),
      ]),
    );

    const blinking = Animated.loop(
      Animated.sequence([
        Animated.delay(2600),
        Animated.timing(blink, { toValue: 0.08, duration: 90, useNativeDriver: true }),
        Animated.timing(blink, { toValue: 1, duration: 110, useNativeDriver: true }),
        Animated.delay(320),
        Animated.timing(blink, { toValue: 0.08, duration: 90, useNativeDriver: true }),
        Animated.timing(blink, { toValue: 1, duration: 110, useNativeDriver: true }),
      ]),
    );

    const wagging = Animated.loop(
      Animated.sequence([
        Animated.timing(tail, {
          toValue: 1,
          duration: 900,
          easing: Easing.inOut(Easing.quad),
          useNativeDriver: true,
        }),
        Animated.timing(tail, {
          toValue: 0,
          duration: 900,
          easing: Easing.inOut(Easing.quad),
          useNativeDriver: true,
        }),
      ]),
    );

    // Steam is driven by useSteam (gated on reduceMotion) above.
    const all = [breathe, blinking, wagging];
    all.forEach((a) => a.start());
    return () => all.forEach((a) => a.stop());
    // Animated.Value handles are useRef-backed and stable for the component's lifetime.
  }, [blink, bob, reduceMotion, tail]);

  // A persistent `say` shows its bubble immediately; a tap-triggered line
  // fades in, holds, and retires itself.
  useEffect(() => {
    if (say) {
      Animated.spring(bubble, {
        toValue: 1,
        friction: 6,
        tension: 160,
        useNativeDriver: true,
      }).start();
    }
  }, [say, bubble]);

  const greet = useCallback(() => {
    if (!interactive) return;
    setTapLine(LINES[Math.floor(Math.random() * LINES.length)]!);
    Animated.sequence([
      Animated.spring(bubble, { toValue: 1, friction: 6, tension: 170, useNativeDriver: true }),
      Animated.delay(1700),
      Animated.timing(bubble, { toValue: say ? 1 : 0, duration: 220, useNativeDriver: true }),
    ]).start(() => {
      if (!say) setTapLine(null);
    });

    if (reduceMotion) return;
    // Squash, then hop.
    jump.setValue(0);
    Animated.sequence([
      Animated.timing(jump, {
        toValue: -1,
        duration: 110,
        easing: Easing.out(Easing.quad),
        useNativeDriver: true,
      }),
      Animated.spring(jump, { toValue: 1, friction: 4, tension: 220, useNativeDriver: true }),
      Animated.spring(jump, { toValue: 0, friction: 6, tension: 180, useNativeDriver: true }),
    ]).start();
  }, [bubble, interactive, jump, reduceMotion, say]);

  const puffStyles = useMemo(
    () =>
      PUFF_CONFIG.map(({ id, offset }, index) => {
        const puff = puffs[index]!;
        return {
          id,
          style: [
            sheet.puff,
            {
              opacity: puff.interpolate({
                inputRange: [0, 0.25, 0.75, 1],
                outputRange: [0, 0.75, 0.35, 0],
              }),
              transform: [
                { translateY: puff.interpolate({ inputRange: [0, 1], outputRange: [4, -16] }) },
                {
                  translateX: puff.interpolate({
                    inputRange: [0, 1],
                    outputRange: [0, offset],
                  }),
                },
                { scale: puff.interpolate({ inputRange: [0, 1], outputRange: [0.5, 1.25] }) },
              ],
            },
          ],
        };
      }),
    [puffs],
  );
  const eyeStyle = useMemo(() => [sheet.eye, { transform: [{ scaleY: blink }] }], [blink]);
  const petTailStyle = useMemo(
    () => [
      sheet.petTail,
      {
        transform: [
          { translateY: 8 },
          {
            rotate: tail.interpolate({
              inputRange: [0, 1],
              outputRange: ['-18deg', '14deg'],
            }),
          },
          { translateY: -8 },
        ],
      },
    ],
    [tail],
  );
  const petEyeStyle = useMemo(() => [sheet.petEye, { transform: [{ scaleY: blink }] }], [blink]);
  const figureStyle = useMemo(
    () => ({
      width: DRAWING_WIDTH * scale,
      height: DRAWING_HEIGHT * scale,
      transform: [
        { scale },
        {
          translateY: Animated.add(
            bob.interpolate({ inputRange: [0, 1], outputRange: [0, -4] }),
            jump.interpolate({ inputRange: [-1, 0, 1], outputRange: [3, 0, -12] }),
          ),
        },
        { scaleY: jump.interpolate({ inputRange: [-1, 0, 1], outputRange: [0.93, 1, 1.05] }) },
      ],
    }),
    [bob, jump, scale],
  );
  const bubbleStyle = useMemo(
    () => [
      sheet.bubble,
      {
        opacity: bubble,
        transform: [
          { scale: bubble.interpolate({ inputRange: [0, 1], outputRange: [0.8, 1] }) },
          { translateY: bubble.interpolate({ inputRange: [0, 1], outputRange: [6, 0] }) },
        ],
      },
    ],
    [bubble],
  );

  const bubbleText = tapLine ?? say;

  const figure = (
    <View style={sheet.drawing}>
      {/* Steam drifting off the top of the toque. */}
      <View style={sheet.steamRow}>
        {puffStyles.map(({ id, style }) => (
          <Animated.View key={id} style={style} />
        ))}
      </View>

      {/* Toque: a soft crown over a firm brim. */}
      <View style={sheet.toqueCrown} />
      <View style={sheet.toqueCrownLeft} />
      <View style={sheet.toqueCrownRight} />
      <View style={sheet.toqueBrim} />

      {/* Head */}
      <View style={sheet.head}>
        <View style={sheet.earLeft} />
        <View style={sheet.earRight} />
        <View style={sheet.eyeRow}>
          <Animated.View style={eyeStyle} />
          <Animated.View style={eyeStyle} />
        </View>
        <View style={sheet.blushRow}>
          <View style={sheet.blush} />
          <View style={sheet.blush} />
        </View>
        <View style={sheet.moustache} />
        <View style={sheet.smile} />
      </View>

      {/* Apron over shoulders, with a pocket and two little hands. */}
      <View style={sheet.body}>
        <View style={sheet.collar} />
        <View style={sheet.pocket} />
      </View>
      <View style={sheet.handLeft} />
      <View style={sheet.handRight} />

      {/* Masala, leaning out from behind Chotu's right leg. */}
      {withPet ? (
        <View style={sheet.pet}>
          <Animated.View style={petTailStyle} />
          <View style={sheet.petBody} />
          <View style={sheet.petHead}>
            <View style={sheet.petEarLeft} />
            <View style={sheet.petEarRight} />
            <View style={sheet.petEyeRow}>
              <Animated.View style={petEyeStyle} />
              <Animated.View style={petEyeStyle} />
            </View>
            <View style={sheet.petNose} />
          </View>
        </View>
      ) : null}
    </View>
  );

  const animatedFigure = <Animated.View style={figureStyle}>{figure}</Animated.View>;

  return (
    <View style={sheet.stage}>
      {bubbleText ? (
        <Animated.View style={bubbleStyle}>
          <Text style={sheet.bubbleText}>{bubbleText}</Text>
          <View style={sheet.bubbleTail} />
        </Animated.View>
      ) : null}

      {interactive ? (
        <Pressable
          accessibilityRole="image"
          accessibilityLabel="Chotu the cook and Masala the kitchen cat. Tap to say hello."
          onPress={greet}
        >
          {animatedFigure}
        </Pressable>
      ) : (
        <View
          accessibilityRole="image"
          accessibilityLabel="Chotu the cook and Masala the kitchen cat"
        >
          {animatedFigure}
        </View>
      )}
    </View>
  );
}

/**
 * Chotu fronting a full-screen state — used for empty households and for the
 * wait while the first week of meals is generated.
 */
export function MascotState({
  title,
  body,
  say,
  children,
}: {
  title: string;
  body?: string;
  say?: string;
  children?: React.ReactNode;
}) {
  return (
    <View style={sheet.state}>
      <Mascot size={158} say={say} />
      <Text style={sheet.stateTitle}>{title}</Text>
      {body ? <Text style={sheet.stateBody}>{body}</Text> : null}
      {children}
    </View>
  );
}

const sheet = StyleSheet.create({
  stage: { alignItems: 'center' },
  drawing: { width: DRAWING_WIDTH, height: DRAWING_HEIGHT, alignItems: 'center' },

  // Steam
  steamRow: { flexDirection: 'row', gap: 5, height: 16, alignItems: 'flex-end' },
  puff: { width: 7, height: 7, borderRadius: 4, backgroundColor: toqueShade },

  // Toque
  toqueCrown: {
    width: 46,
    height: 30,
    borderRadius: 18,
    backgroundColor: toque,
    marginBottom: -12,
    zIndex: 3,
  },
  toqueCrownLeft: {
    position: 'absolute',
    top: 22,
    left: 36,
    width: 24,
    height: 22,
    borderRadius: 12,
    backgroundColor: toque,
    zIndex: 2,
  },
  toqueCrownRight: {
    position: 'absolute',
    top: 22,
    right: 36,
    width: 24,
    height: 22,
    borderRadius: 12,
    backgroundColor: toque,
    zIndex: 2,
  },
  toqueBrim: {
    width: 62,
    height: 14,
    borderRadius: 7,
    backgroundColor: toque,
    borderBottomWidth: 3,
    borderBottomColor: toqueShade,
    zIndex: 4,
  },

  // Head
  // The brim overlaps the brow rather than perching above it, which keeps the
  // forehead from reading as bald at large sizes.
  head: {
    width: 58,
    height: 54,
    borderRadius: 27,
    backgroundColor: skin,
    marginTop: -9,
    alignItems: 'center',
    zIndex: 1,
  },
  earLeft: {
    position: 'absolute',
    left: -5,
    top: 22,
    width: 10,
    height: 14,
    borderRadius: 6,
    backgroundColor: skinShade,
  },
  earRight: {
    position: 'absolute',
    right: -5,
    top: 22,
    width: 10,
    height: 14,
    borderRadius: 6,
    backgroundColor: skinShade,
  },
  eyeRow: { flexDirection: 'row', gap: 14, marginTop: 19 },
  eye: { width: 7, height: 9, borderRadius: 4, backgroundColor: hair },
  blushRow: { flexDirection: 'row', gap: 22, marginTop: 2 },
  blush: { width: 9, height: 4, borderRadius: 2, backgroundColor: blush, opacity: 0.55 },
  moustache: { width: 22, height: 5, borderRadius: 3, backgroundColor: hair, marginTop: 4 },
  smile: {
    width: 13,
    height: 6,
    marginTop: 3,
    borderBottomWidth: 2,
    borderBottomColor: hair,
    borderBottomLeftRadius: 8,
    borderBottomRightRadius: 8,
  },

  // Apron
  body: {
    width: 66,
    height: 42,
    marginTop: -4,
    borderTopLeftRadius: 22,
    borderTopRightRadius: 22,
    borderBottomLeftRadius: 12,
    borderBottomRightRadius: 12,
    backgroundColor: apron,
    alignItems: 'center',
  },
  collar: {
    width: 20,
    height: 8,
    borderBottomLeftRadius: 10,
    borderBottomRightRadius: 10,
    backgroundColor: toque,
  },
  pocket: {
    width: 26,
    height: 14,
    marginTop: 8,
    borderRadius: 5,
    borderWidth: 2,
    borderColor: apronDark,
  },
  handLeft: {
    position: 'absolute',
    bottom: 30,
    left: 31,
    width: 13,
    height: 13,
    borderRadius: 7,
    backgroundColor: skin,
  },
  handRight: {
    position: 'absolute',
    bottom: 30,
    right: 31,
    width: 13,
    height: 13,
    borderRadius: 7,
    backgroundColor: skin,
  },

  // Masala the cat
  pet: { position: 'absolute', right: 12, bottom: 0, width: 44, height: 40, alignItems: 'center' },
  petTail: {
    position: 'absolute',
    right: 1,
    bottom: 7,
    width: 7,
    height: 22,
    borderRadius: 4,
    backgroundColor: gingerDark,
  },
  petBody: {
    position: 'absolute',
    bottom: 0,
    width: 30,
    height: 20,
    borderTopLeftRadius: 14,
    borderTopRightRadius: 14,
    backgroundColor: ginger,
  },
  petHead: {
    position: 'absolute',
    bottom: 12,
    width: 28,
    height: 24,
    borderRadius: 13,
    backgroundColor: ginger,
    alignItems: 'center',
  },
  petEarLeft: {
    position: 'absolute',
    top: -5,
    left: 3,
    width: 0,
    height: 0,
    borderLeftWidth: 5,
    borderRightWidth: 5,
    borderBottomWidth: 8,
    borderLeftColor: transparent,
    borderRightColor: transparent,
    borderBottomColor: ginger,
  },
  petEarRight: {
    position: 'absolute',
    top: -5,
    right: 3,
    width: 0,
    height: 0,
    borderLeftWidth: 5,
    borderRightWidth: 5,
    borderBottomWidth: 8,
    borderLeftColor: transparent,
    borderRightColor: transparent,
    borderBottomColor: ginger,
  },
  petEyeRow: { flexDirection: 'row', gap: 8, marginTop: 8 },
  petEye: { width: 4, height: 5, borderRadius: 2, backgroundColor: hair },
  petNose: { width: 4, height: 3, borderRadius: 2, backgroundColor: gingerDark, marginTop: 2 },

  // Speech bubble
  bubble: {
    backgroundColor: colors.card,
    borderRadius: radius.lg,
    paddingHorizontal: space.lg,
    paddingVertical: space.md,
    marginBottom: space.sm,
    maxWidth: 220,
    ...shadow.soft,
  },
  bubbleText: { fontFamily: fonts.display, fontSize: 17, color: colors.ink, textAlign: 'center' },
  bubbleTail: {
    position: 'absolute',
    bottom: -6,
    alignSelf: 'center',
    left: '50%',
    marginLeft: -7,
    width: 0,
    height: 0,
    borderLeftWidth: 7,
    borderRightWidth: 7,
    borderTopWidth: 8,
    borderLeftColor: transparent,
    borderRightColor: transparent,
    borderTopColor: colors.card,
  },

  // Full-screen state
  state: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: space.xl,
    gap: space.md,
    backgroundColor: colors.surface,
  },
  stateTitle: {
    fontFamily: fonts.display,
    fontSize: 30,
    lineHeight: 36,
    fontWeight: '700',
    color: colors.ink,
    textAlign: 'center',
    marginTop: space.sm,
  },
  stateBody: {
    fontSize: 16,
    lineHeight: 23,
    color: colors.inkSoft,
    textAlign: 'center',
    maxWidth: 300,
  },
});
