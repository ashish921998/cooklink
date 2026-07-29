import { StyleSheet, Text, View } from 'react-native';
import type { HouseholdSummary } from '../lib/households';
import {
  Card,
  Chip,
  FadeSlideIn,
  TabScrollView,
  colors,
  fonts,
  radius,
  shadow,
  space,
  styles,
} from '../components/ui';
import { Mascot } from '../components/Mascot';

/**
 * The Groceries destination (issue 03). For a Member this is where Grocery
 * Requests, the Suggested Grocery Cart, and orders live; for a Cook it is
 * Grocery Requests only, with no purchasing authority. The detailed surfaces
 * arrive in later tickets; this destination exists so the persistent
 * navigation bar is real and labelled today.
 *
 * Until those surfaces land, the screen states plainly what will appear here
 * and what the current role will be able to do — an empty state that explains
 * itself, rather than an empty card that looks broken. Nothing here implies
 * data that does not exist yet.
 */

const ROLE_COPY = {
  cook: {
    heading: 'Tell the household what ran out',
    body: 'Describe a missing ingredient in your own words — by text or voice note. A household member reviews it before anything is ordered.',
    steps: [
      { glyph: '🎤', label: 'Say what is missing', note: 'In English or Hindi' },
      { glyph: '👀', label: 'The household reviews it', note: 'You need no purchasing rights' },
      { glyph: '🛒', label: 'It joins the next order', note: 'Once a member approves' },
    ],
  },
  member: {
    heading: 'Approve requests, then order',
    body: 'Your cook’s requests land here alongside a suggested cart for the next three days of planned meals. Nothing is ever bought without your confirmation.',
    steps: [
      { glyph: '📝', label: 'Review cook requests', note: 'Approve or skip each one' },
      { glyph: '🛒', label: 'Check the suggested cart', note: 'Built from your meal plan' },
      { glyph: '✅', label: 'Confirm checkout', note: 'You place every order' },
    ],
  },
} as const;

export function GroceriesScreen({ household }: { household: HouseholdSummary }) {
  const isCook = household.role === 'cook';
  const copy = isCook ? ROLE_COPY.cook : ROLE_COPY.member;

  return (
    <TabScrollView contentContainerStyle={grocery.scroll} showsVerticalScrollIndicator={false}>
      <FadeSlideIn>
        <View style={grocery.head}>
          <Text style={styles.eyebrow}>{isCook ? 'Cook' : 'Member'} · Groceries</Text>
          <Text style={grocery.title}>{copy.heading}</Text>
        </View>
      </FadeSlideIn>

      <FadeSlideIn delay={90}>
        <View style={grocery.hero}>
          <Mascot size={124} withPet={!isCook} />
          <Text style={grocery.heroBody}>{copy.body}</Text>
        </View>
      </FadeSlideIn>

      <FadeSlideIn delay={170}>
        <Card>
          <View style={grocery.cardHead}>
            <Text style={styles.cardTitle}>How it will work</Text>
            <Chip label="Soon" tint={colors.field} ink={colors.inkSoft} />
          </View>
          {copy.steps.map((step, i) => (
            <View key={step.label} style={grocery.step}>
              <View style={grocery.stepGlyph}>
                <Text style={grocery.stepGlyphText}>{step.glyph}</Text>
              </View>
              <View style={grocery.stepText}>
                <Text style={grocery.stepLabel}>{step.label}</Text>
                <Text style={grocery.stepNote}>{step.note}</Text>
              </View>
              <Text style={grocery.stepIndex}>{i + 1}</Text>
            </View>
          ))}
        </Card>
      </FadeSlideIn>
    </TabScrollView>
  );
}

const grocery = StyleSheet.create({
  scroll: {
    paddingHorizontal: space.xl,
    paddingTop: space.sm,
    paddingBottom: space.xxl,
    gap: space.lg,
  },
  head: { gap: space.xs },
  title: {
    fontFamily: fonts.display,
    fontSize: 28,
    lineHeight: 34,
    fontWeight: '700',
    color: colors.ink,
    letterSpacing: -0.3,
  },

  hero: {
    alignItems: 'center',
    gap: space.md,
    borderRadius: radius.xl,
    backgroundColor: colors.accentSoft,
    paddingHorizontal: space.xl,
    paddingTop: space.lg,
    paddingBottom: space.xl,
    ...shadow.soft,
  },
  heroBody: { fontSize: 15, lineHeight: 22, color: colors.ink, textAlign: 'center' },

  cardHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  step: { flexDirection: 'row', alignItems: 'center', gap: space.md, paddingVertical: space.sm },
  stepGlyph: {
    width: 42,
    height: 42,
    borderRadius: 21,
    backgroundColor: colors.surfaceDeep,
    alignItems: 'center',
    justifyContent: 'center',
  },
  stepGlyphText: { fontSize: 19 },
  stepText: { flex: 1, gap: 1 },
  stepLabel: { fontSize: 15, fontWeight: '700', color: colors.ink },
  stepNote: { fontSize: 13, color: colors.inkSoft },
  stepIndex: { fontFamily: fonts.display, fontSize: 17, color: colors.border, fontWeight: '700' },
});
