import { useEffect, useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { useAccessProbe, type HouseholdSummary } from '../lib/households';
import {
  Avatar,
  BottomTabs,
  TabBarMinimizeProvider,
  useTabBarClearance,
  Chip,
  FadeSlideIn,
  PressableScale,
  colors,
  fonts,
  radius,
  shadow,
  space,
  styles,
  type TabKey,
  type TabSpec,
} from '../components/ui';
import { Mascot, MascotState } from '../components/Mascot';
import { MealPlanScreen } from './MealPlan';
import { GroceriesScreen } from './Groceries';
import { ChatScreen } from './Chat';

const COOK_TABS: readonly TabSpec[] = [
  { key: 'chat', label: 'Chat', icon: 'chat' },
  { key: 'mealPlan', label: 'Meal Plan', icon: 'calendar' },
  { key: 'groceries', label: 'Groceries', icon: 'basket' },
];

/**
 * The Cook entry shell (issue 03 — Variant A). A Cook always launches into the
 * WhatsApp-like Household list, even with exactly one Household. Selecting a
 * Household always opens Chat with Chat, Meal Plan, and Groceries as the three
 * persistent destinations. A visible back action returns to the list.
 *
 * Household-scoped UI state lives only while a Household is open: switching
 * Households resets the tab to Chat (the Cook's default) and discards the
 * previous Household's draft state, so nothing leaks across Households.
 */
export function CookShell({
  households,
  onSelectHousehold,
}: {
  households: HouseholdSummary[];
  onSelectHousehold: (householdId: string) => void;
}) {
  // A Cook always launches into the Household list, even with one Household
  // (issue 03 — do not auto-open the sole Household). `openId` is only ever
  // set by an explicit tap on a row.
  const [openId, setOpenId] = useState<string | null>(null);

  // Reset any open Household whenever the available set changes so a removed
  // Cook Household never lingers on screen.
  useEffect(() => {
    if (openId && !households.some((h) => h.id === openId)) setOpenId(null);
  }, [households, openId]);

  const selected = households.find((h) => h.id === openId) ?? null;

  if (!selected) {
    return (
      <CookHouseholdList
        households={households}
        onSelect={(householdId) => {
          setOpenId(householdId);
          onSelectHousehold(householdId);
        }}
      />
    );
  }

  return (
    <CookHousehold key={selected.id} household={selected} onBackToList={() => setOpenId(null)} />
  );
}

/**
 * The Cook's stable cross-Household home. Always shown, including for a single
 * Household (issue 03 — do not auto-open the sole Household).
 */
function CookHouseholdList({
  households,
  onSelect,
}: {
  households: HouseholdSummary[];
  onSelect: (householdId: string) => void;
}) {
  if (households.length === 0) {
    return (
      <MascotState
        title="No households yet"
        body="You join a household when its owner sends you a Cook invite through WhatsApp."
        say="Soon!"
      />
    );
  }
  return (
    <ScrollView contentContainerStyle={cook.scroll} showsVerticalScrollIndicator={false}>
      <FadeSlideIn>
        <View style={cook.head}>
          <View style={cook.headText}>
            <Text style={styles.eyebrow}>Cook</Text>
            <Text style={cook.title}>Your kitchens</Text>
            <Text style={styles.subtitle}>
              {households.length === 1
                ? 'One household is waiting for you.'
                : `${households.length} households are waiting for you.`}
            </Text>
          </View>
          <Mascot size={98} withPet={false} />
        </View>
      </FadeSlideIn>

      {households.map((household, i) => (
        <FadeSlideIn key={household.id} delay={90 + i * 60}>
          <PressableScale
            accessibilityRole="button"
            accessibilityLabel={`Open ${household.name} chat`}
            style={cook.row}
            onPress={() => onSelect(household.id)}
          >
            <Avatar name={household.name} size={48} />
            <View style={cook.rowText}>
              <Text style={cook.rowName} numberOfLines={1}>
                {household.name}
              </Text>
              <Text style={cook.rowNote}>Chat · Meal Plan · Groceries</Text>
            </View>
            <Text style={cook.chevron}>›</Text>
          </PressableScale>
        </FadeSlideIn>
      ))}
    </ScrollView>
  );
}

/**
 * A selected Cook Household. Chat opens by default; the three persistent
 * destinations are Chat, Meal Plan, and Groceries. The tab state is local to
 * this Household and is discarded on back (issue 03 — no leakage).
 */
function CookHousehold({
  household,
  onBackToList,
}: {
  household: HouseholdSummary;
  onBackToList: () => void;
}) {
  const [tab, setTab] = useState<TabKey>('chat');
  const { revoked } = useAccessProbe(household.id);
  const clearance = useTabBarClearance();

  // A removed Cook exits immediately with a plain explanation (issue 03).
  if (revoked)
    return (
      <MascotState
        title="Access changed"
        body={`You no longer cook for ${household.name}. Ask the owner to invite you again.`}
      />
    );

  return (
    <TabBarMinimizeProvider>
      <View style={cook.root}>
        {/* Chat carries its own back action; the other two destinations get a
            household header with the same escape hatch. */}
        {tab === 'chat' ? (
          // Chat ends in a composer rather than a scroll, so it cannot reserve
          // room for the floating bar itself — the shell holds it clear. Its own
          // edge padding is subtracted so the gap does not double up.
          <View style={{ flex: 1, paddingBottom: clearance - space.xl }}>
            <ChatScreen household={household} backLabel="Kitchens" onBack={onBackToList} />
          </View>
        ) : (
          <>
            <View style={cook.openHeader}>
              <PressableScale
                accessibilityRole="button"
                accessibilityLabel="Back to your kitchens"
                style={cook.backButton}
                onPress={onBackToList}
              >
                <Text style={styles.backLink}>‹</Text>
              </PressableScale>
              <Avatar name={household.name} size={36} />
              <Text style={cook.openName} numberOfLines={1}>
                {household.name}
              </Text>
              <Chip label="Cook" tint={colors.accentSoft} ink={colors.accent} />
            </View>
            {tab === 'mealPlan' ? (
              <MealPlanScreen household={household} />
            ) : (
              <GroceriesScreen household={household} />
            )}
          </>
        )}
        <BottomTabs tabs={COOK_TABS} active={tab} onSelect={setTab} />
      </View>
    </TabBarMinimizeProvider>
  );
}

const cook = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.surface },

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

  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.lg,
    borderRadius: radius.lg,
    backgroundColor: colors.card,
    padding: space.lg,
    minHeight: 76,
    ...shadow.soft,
  },
  rowText: { flex: 1, gap: 2 },
  rowName: { fontFamily: fonts.display, fontSize: 19, fontWeight: '700', color: colors.ink },
  rowNote: { fontSize: 13, color: colors.inkSoft },
  chevron: { fontSize: 24, color: colors.inkSoft },

  openHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    paddingHorizontal: space.lg,
    paddingTop: 58,
    paddingBottom: space.md,
    backgroundColor: colors.surface,
  },
  backButton: { minHeight: 44, minWidth: 28, alignItems: 'center', justifyContent: 'center' },
  openName: {
    flex: 1,
    fontFamily: fonts.display,
    fontSize: 19,
    fontWeight: '700',
    color: colors.ink,
  },
});
