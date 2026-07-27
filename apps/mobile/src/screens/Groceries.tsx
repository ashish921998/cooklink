import { ScrollView, Text } from 'react-native';
import type { HouseholdSummary } from '../lib/households';
import { Card, styles } from '../components/ui';

/**
 * The Groceries destination (issue 03). For a Member this is where Grocery
 * Requests, the Suggested Grocery Cart, and orders live; for a Cook it is
 * Grocery Requests only, with no purchasing authority. The detailed surfaces
 * arrive in later tickets; this destination exists so the persistent
 * navigation bar is real and labelled today.
 */
export function GroceriesScreen({ household }: { household: HouseholdSummary }) {
  const isCook = household.role === 'cook';
  return (
    <ScrollView contentContainerStyle={styles.screen}>
      <Text style={styles.eyebrow}>{isCook ? 'Cook' : 'Member'} · Groceries</Text>
      <Text style={styles.title}>{household.name}</Text>
      <Card>
        <Text style={styles.cardTitle}>{isCook ? 'Grocery Requests' : 'Pending review'}</Text>
        <Text style={styles.subtitle}>
          {isCook
            ? 'Describe a missing ingredient here. Your household reviews it before ordering.'
            : 'Approved requests and the suggested three-day cart appear here.'}
        </Text>
      </Card>
    </ScrollView>
  );
}
