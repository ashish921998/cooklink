import { useEffect, useMemo, useState } from 'react';
import { ScrollView, Text, View } from 'react-native';
import { useApi } from '../lib/api';
import type { HouseholdSummary, PlannedMeal } from '../lib/households';
import { Card, Loading, styles } from '../components/ui';

/**
 * The seven-day Weekly Meal Plan destination, shared by the Member and Cook
 * shells (issue 03 — Meal Plan is a persistent destination for both roles).
 * The server authorizes the read; this component only renders authorized rows.
 */
export function MealPlanScreen({ household }: { household: HouseholdSummary }) {
  const api = useApi();
  const [meals, setMeals] = useState<PlannedMeal[] | null>(null);

  useEffect(() => {
    setMeals(null);
    api<{ meals: PlannedMeal[] }>(`/v1/households/${household.id}/meal-plan`).then((data) =>
      setMeals(data.meals),
    );
  }, [api, household.id]);

  const today = useMemo(() => new Date().toISOString().slice(0, 10), []);
  const days = useMemo(() => [...new Set((meals ?? []).map((m) => m.date))], [meals]);

  if (!meals) return <Loading />;
  return (
    <ScrollView contentContainerStyle={styles.screen}>
      <Text style={styles.eyebrow}>
        {household.role === 'cook' ? 'Cook' : 'Member'} · Meal Plan
      </Text>
      <Text style={styles.title}>{household.name}</Text>
      {meals.length === 0 ? (
        <Card>
          <Text style={styles.subtitle}>No meals planned yet.</Text>
        </Card>
      ) : (
        days.map((day) => (
          <View key={day} style={styles.dayGroup}>
            <Text style={styles.sectionTitle}>{day === today ? 'Today' : day}</Text>
            {meals
              .filter((m) => m.date === day)
              .map((meal) => (
                <View key={meal.id} style={styles.mealRow}>
                  <Text style={styles.mealType}>{meal.mealType}</Text>
                  <Text style={styles.mealName}>
                    {meal.name}
                    {meal.isSpecial ? ' · special' : ''}
                  </Text>
                </View>
              ))}
          </View>
        ))
      )}
    </ScrollView>
  );
}
