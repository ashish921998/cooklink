import { Pressable, ScrollView, Text, View } from 'react-native';
import type { HouseholdSummary } from '../lib/households';
import { Card, styles } from '../components/ui';

/**
 * Household Chat (issue 03 navigation, full chat in a later ticket). For a
 * Cook this is the default destination after selecting a Household; for a
 * Member it is a header action pushed over the current tab, and back returns
 * to that tab.
 *
 * This skeleton renders the pinned "Today's cooking" card for Cooks and a plain
 * first-message prompt, so the navigation contract is real today: Chat opens,
 * Cooks see their cooking focus, and back behaves correctly.
 */
export function ChatScreen({
  household,
  onBack,
  backLabel,
}: {
  household: HouseholdSummary;
  onBack: () => void;
  backLabel: string;
}) {
  const isCook = household.role === 'cook';
  return (
    <ScrollView contentContainerStyle={styles.screen}>
      <Pressable accessibilityRole="button" onPress={onBack}>
        <Text style={styles.backLink}>‹ {backLabel}</Text>
      </Pressable>
      <Text style={styles.eyebrow}>{household.name}</Text>
      <Text style={styles.title}>Household Chat</Text>
      {isCook ? <TodaysCookingCard household={household} /> : null}
      <Card>
        <Text style={styles.cardTitle}>Shared conversation</Text>
        <Text style={styles.subtitle}>
          Messages, photos, and voice notes between everyone in {household.name}.
        </Text>
      </Card>
    </ScrollView>
  );
}

/**
 * The Cook's pinned focus card (issue 03 — Today's cooking lives at the top of
 * Chat, not as a fourth destination). Opens the Daily Cook View.
 */
function TodaysCookingCard({ household }: { household: HouseholdSummary }) {
  return (
    <View style={styles.card}>
      <Text style={styles.eyebrow}>Today's cooking</Text>
      <Text style={styles.subtitle}>
        The confirmed meals for {household.name} today, with Recipe Guides.
      </Text>
    </View>
  );
}
