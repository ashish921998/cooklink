import { useEffect, useState } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { useAccessProbe, type HouseholdSummary } from '../lib/households';
import {
  BottomTabs,
  Message,
  styles,
  type TabKey,
  type TabSpec,
} from '../components/ui';
import { MealPlanScreen } from './MealPlan';
import { GroceriesScreen } from './Groceries';
import { ChatScreen } from './Chat';

const COOK_TABS: readonly TabSpec[] = [
  { key: 'chat', label: 'Chat', glyph: '💬' },
  { key: 'mealPlan', label: 'Meal Plan', glyph: '◳' },
  { key: 'groceries', label: 'Groceries', glyph: '▦' },
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
    return <CookHouseholdList households={households} onSelect={onSelectHousehold} />;
  }

  return (
    <CookHousehold
      key={selected.id}
      household={selected}
      onBackToList={() => setOpenId(null)}
    />
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
      <Message
        title="No households yet"
        body="You join a household when its owner sends you a Cook invite through WhatsApp."
      />
    );
  }
  return (
    <ScrollView contentContainerStyle={styles.screen}>
      <Text style={styles.eyebrow}>Cook</Text>
      <Text style={styles.title}>Households</Text>
      {households.map((household) => (
        <Pressable
          key={household.id}
          accessibilityRole="button"
          accessibilityLabel={`Open ${household.name} chat`}
          style={styles.card}
          onPress={() => onSelect(household.id)}
        >
          <Text style={styles.cardTitle}>{household.name}</Text>
          <Text style={styles.subtitle}>Chat first · Meal Plan · Groceries</Text>
        </Pressable>
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

  // A removed Cook exits immediately with a plain explanation (issue 03).
  if (revoked)
    return (
      <Message
        title="Access changed"
        body={`You no longer cook for ${household.name}. Ask the owner to invite you again.`}
      />
    );

  return (
    <View style={{ flex: 1 }}>
      {tab === 'chat' ? (
        <ChatScreen household={household} backLabel="Households" onBack={onBackToList} />
      ) : tab === 'mealPlan' ? (
        <MealPlanScreen household={household} />
      ) : (
        <GroceriesScreen household={household} />
      )}
      <View style={switchStyles.switchRow}>
        <Pressable accessibilityRole="button" style={styles.ghostButton} onPress={onBackToList}>
          <Text style={styles.ghostButtonText}>Switch household</Text>
        </Pressable>
      </View>
      <BottomTabs tabs={COOK_TABS} active={tab} onSelect={setTab} />
    </View>
  );
}

const switchStyles = {
  switchRow: { paddingHorizontal: 24, paddingVertical: 8, backgroundColor: '#f7f3ed' },
};
