import { useCallback, useEffect, useMemo, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { useApi } from '../lib/api';
import type { HouseholdSummary, PlannedMeal, RecipeSearchResult } from '../lib/households';
import { Card, Loading, Message, styles } from '../components/ui';

/**
 * The seven-day Weekly Meal Plan destination, shared by the Member and Cook
 * shells (issue 03 / ticket 05). Supports viewing, editing, search-and-replace,
 * swap, regenerate, per-meal serving-count override, stale-conflict
 * confirmation, and Hindi labels — all from either role.
 *
 * The server is the source of truth and authorizes every write; this
 * component only renders authorized rows and surfaces conflicts for fresh
 * confirmation rather than silently overwriting.
 */

type Lang = 'en' | 'hi';

const LABELS: Record<
  Lang,
  {
    cook: string;
    member: string;
    mealPlan: string;
    noMeals: string;
    today: string;
    special: string;
    servings: string;
    edit: string;
    swap: string;
    regenerate: string;
    regenerateDay: string;
    regenerateWeek: string;
    searchReplace: string;
    save: string;
    cancel: string;
    useLatest: string;
    mealName: string;
    searchPlaceholder: string;
    dietMismatch: string;
    conflictTitle: string;
    conflictBody: string;
    regenerating: string;
    saving: string;
    swapPrompt: string;
    swapCancel: string;
  }
> = {
  en: {
    cook: 'Cook',
    member: 'Member',
    mealPlan: 'Meal Plan',
    noMeals: 'No meals planned yet.',
    today: 'Today',
    special: 'special',
    servings: 'Servings',
    edit: 'Edit name',
    swap: 'Swap',
    regenerate: 'Regenerate',
    regenerateDay: 'Regenerate day',
    regenerateWeek: 'Regenerate week',
    searchReplace: 'Search & replace',
    save: 'Save',
    cancel: 'Cancel',
    useLatest: 'Use latest',
    mealName: 'Meal name',
    searchPlaceholder: 'Search recipes…',
    dietMismatch: 'Out of diet',
    conflictTitle: 'Meal changed',
    conflictBody: 'Someone else updated this meal. Review the latest version and try again.',
    regenerating: 'Regenerating…',
    saving: 'Saving…',
    swapPrompt: 'Tap another meal to swap',
    swapCancel: 'Cancel swap',
  },
  hi: {
    cook: 'रसोई',
    member: 'सदस्य',
    mealPlan: 'भोजन योजना',
    noMeals: 'अभी कोई भोजन योजनित नहीं है।',
    today: 'आज',
    special: 'विशेष',
    servings: 'सर्विंग',
    edit: 'नाम बदलें',
    swap: 'बदलें',
    regenerate: 'पुनः बनाएँ',
    regenerateDay: 'दिन पुनः बनाएँ',
    regenerateWeek: 'सप्ताह पुनः बनाएँ',
    searchReplace: 'खोजें और बदलें',
    save: 'सहेजें',
    cancel: 'रद्द करें',
    useLatest: 'नवीनतम उपयोग करें',
    mealName: 'भोजन का नाम',
    searchPlaceholder: 'व्यंजन खोजें…',
    dietMismatch: 'आहार से बाहर',
    conflictTitle: 'भोजन बदल गया',
    conflictBody: 'किसी और ने इस भोजन को अपडेट किया। नवीनतम संस्करण देखें और पुनः प्रयास करें।',
    regenerating: 'पुनः बनाया जा रहा है…',
    saving: 'सहेजा जा रहा है…',
    swapPrompt: 'बदलने के लिए दूसरा भोजन चुनें',
    swapCancel: 'बदलना रद्द करें',
  },
};

export function MealPlanScreen({ household }: { household: HouseholdSummary }) {
  const api = useApi();
  const lang: Lang = household.defaultLanguage === 'hi' ? 'hi' : 'en';
  const t = LABELS[lang];
  const [meals, setMeals] = useState<PlannedMeal[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editingMeal, setEditingMeal] = useState<PlannedMeal | null>(null);
  const [swapSource, setSwapSource] = useState<PlannedMeal | null>(null);
  const [conflict, setConflict] = useState<{ current: PlannedMeal } | null>(null);

  const loadPlan = useCallback(async () => {
    setMeals(null);
    setError(null);
    try {
      const data = await api<{ meals: PlannedMeal[] }>(`/v1/households/${household.id}/meal-plan`);
      setMeals(data.meals);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load meal plan.');
    }
  }, [api, household.id]);

  useEffect(() => {
    void loadPlan();
  }, [loadPlan]);

  const today = useMemo(() => new Date().toISOString().slice(0, 10), []);
  const days = useMemo(() => [...new Set((meals ?? []).map((m) => m.date))], [meals]);

  // Merge an updated meal back into the local plan.
  const mergeMeal = useCallback((updated: PlannedMeal) => {
    setMeals((prev) => (prev ?? []).map((m) => (m.id === updated.id ? updated : m)));
  }, []);

  // Merge a swapped pair back into the local plan.
  const mergeSwapped = useCallback((a: PlannedMeal, b: PlannedMeal) => {
    setMeals((prev) => (prev ?? []).map((m) => (m.id === a.id ? a : m.id === b.id ? b : m)));
  }, []);

  // Handle a stale-version conflict (409): surface the current meal for
  // fresh confirmation instead of silently overwriting.
  const handleConflict = useCallback(
    async (mealId: string) => {
      try {
        const data = await api<{ meals: PlannedMeal[] }>(
          `/v1/households/${household.id}/meal-plan`,
        );
        const current = data.meals.find((m) => m.id === mealId);
        if (current) {
          setMeals(data.meals);
          setConflict({ current });
        }
      } catch {
        setError('Could not resolve the conflict. Pull to refresh.');
      }
    },
    [api, household.id],
  );

  async function editMeal(meal: PlannedMeal, patch: Partial<PlannedMeal>) {
    try {
      const data = await api<{ meal: PlannedMeal }>(
        `/v1/households/${household.id}/meal-plan/meals/${meal.id}`,
        {
          method: 'PATCH',
          body: JSON.stringify({ expectedVersion: meal.version, ...patch }),
        },
      );
      mergeMeal(data.meal);
      setEditingMeal(null);
    } catch (err) {
      const msg = err instanceof Error ? err.message : '';
      if (msg.includes('409')) {
        void handleConflict(meal.id);
      } else {
        setError(msg || 'Could not save the meal.');
      }
    }
  }

  async function swapMeals(a: PlannedMeal, b: PlannedMeal) {
    try {
      const data = await api<{ meals: PlannedMeal[] }>(
        `/v1/households/${household.id}/meal-plan/swap`,
        {
          method: 'POST',
          body: JSON.stringify({
            a: { mealId: a.id, expectedVersion: a.version },
            b: { mealId: b.id, expectedVersion: b.version },
          }),
        },
      );
      mergeSwapped(data.meals[0]!, data.meals[1]!);
      setSwapSource(null);
    } catch (err) {
      const msg = err instanceof Error ? err.message : '';
      if (msg.includes('409')) {
        void handleConflict(a.id);
      } else {
        setError(msg || 'Could not swap the meals.');
      }
      setSwapSource(null);
    }
  }

  async function regenerate(opts: {
    kind: 'meal' | 'day' | 'remaining_week';
    mealId?: string;
    fromDate?: string;
    includeEdited?: boolean;
  }) {
    try {
      const data = await api<{ meals: PlannedMeal[]; changed: boolean }>(
        `/v1/households/${household.id}/meal-plan/regenerate`,
        { method: 'POST', body: JSON.stringify(opts) },
      );
      if (data.changed) {
        const byId = new Map(data.meals.map((m) => [m.id, m]));
        setMeals((prev) => (prev ?? []).map((m) => byId.get(m.id) ?? m));
      }
      setEditingMeal(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not regenerate.');
    }
  }

  if (!meals) return <Loading />;
  if (error && meals.length === 0) return <Message title="Meal Plan" body={error} />;

  return (
    <ScrollView contentContainerStyle={styles.screen}>
      <Text style={styles.eyebrow}>
        {household.role === 'cook' ? t.cook : t.member} · {t.mealPlan}
      </Text>
      <Text style={styles.title}>{household.name}</Text>

      {swapSource ? (
        <Card>
          <Text style={styles.subtitle}>
            {t.swapPrompt}: {swapSource.name}
          </Text>
          <Pressable
            accessibilityRole="button"
            style={styles.ghostButton}
            onPress={() => setSwapSource(null)}
          >
            <Text style={styles.ghostButtonText}>{t.swapCancel}</Text>
          </Pressable>
        </Card>
      ) : null}

      {error ? <Text style={styles.error}>{error}</Text> : null}

      {meals.length === 0 ? (
        <Card>
          <Text style={styles.subtitle}>{t.noMeals}</Text>
        </Card>
      ) : (
        days.map((day) => (
          <View key={day} style={styles.dayGroup}>
            <View style={dayHeaderStyles.row}>
              <Text style={styles.sectionTitle}>{day === today ? t.today : day}</Text>
              <Pressable
                accessibilityRole="button"
                style={styles.ghostButton}
                onPress={() => void regenerate({ kind: 'day', fromDate: day })}
              >
                <Text style={styles.ghostButtonText}>{t.regenerateDay}</Text>
              </Pressable>
            </View>
            {meals
              .filter((m) => m.date === day)
              .map((meal) => (
                <MealRow
                  key={meal.id}
                  meal={meal}
                  lang={lang}
                  isSwapSource={swapSource?.id === meal.id}
                  onOpen={() => setEditingMeal(meal)}
                  onSwapSelect={() => {
                    if (swapSource && swapSource.id !== meal.id) {
                      void swapMeals(swapSource, meal);
                    }
                  }}
                />
              ))}
          </View>
        ))
      )}

      <Pressable
        accessibilityRole="button"
        style={styles.secondaryButton}
        onPress={() =>
          void regenerate({ kind: 'remaining_week', fromDate: today, includeEdited: false })
        }
      >
        <Text style={styles.secondaryButtonText}>{t.regenerateWeek}</Text>
      </Pressable>

      {editingMeal ? (
        <MealDetailSheet
          meal={editingMeal}
          household={household}
          lang={lang}
          onClose={() => setEditingMeal(null)}
          onEdit={(patch) => void editMeal(editingMeal, patch)}
          onRegenerate={(kind) => {
            if (kind === 'meal') {
              void regenerate({ kind: 'meal', mealId: editingMeal.id });
            }
          }}
          onSwap={() => {
            setSwapSource(editingMeal);
            setEditingMeal(null);
          }}
        />
      ) : null}

      {conflict ? (
        <ConflictSheet
          lang={lang}
          current={conflict.current}
          onClose={() => setConflict(null)}
          onUseLatest={() => {
            setEditingMeal(conflict.current);
            setConflict(null);
          }}
        />
      ) : null}
    </ScrollView>
  );
}

function MealRow({
  meal,
  lang,
  isSwapSource,
  onOpen,
  onSwapSelect,
}: {
  meal: PlannedMeal;
  lang: Lang;
  isSwapSource: boolean;
  onOpen: () => void;
  onSwapSelect: () => void;
}) {
  const t = LABELS[lang];
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${meal.mealType} ${meal.name}`}
      style={[styles.mealRow, isSwapSource && selectedStyles.row]}
      onPress={isSwapSource ? onSwapSelect : onOpen}
    >
      <Text style={styles.mealType}>{meal.mealType}</Text>
      <Text style={styles.mealName}>
        {meal.name}
        {meal.isSpecial ? ` · ${t.special}` : ''}
        {meal.servingsOverridden ? ` · ${meal.servings} ${t.servings}` : ''}
      </Text>
    </Pressable>
  );
}

function MealDetailSheet({
  meal,
  household,
  lang,
  onClose,
  onEdit,
  onRegenerate,
  onSwap,
}: {
  meal: PlannedMeal;
  household: HouseholdSummary;
  lang: Lang;
  onClose: () => void;
  onEdit: (patch: Partial<PlannedMeal>) => void;
  onRegenerate: (kind: 'meal') => void;
  onSwap: () => void;
}) {
  const t = LABELS[lang];
  const [mode, setMode] = useState<'details' | 'editName' | 'search'>('details');
  const [nameDraft, setNameDraft] = useState(meal.name);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<RecipeSearchResult[]>([]);
  const [busy, setBusy] = useState(false);
  const api = useApi();

  async function runSearch(q: string) {
    if (!q.trim()) {
      setSearchResults([]);
      return;
    }
    try {
      const data = await api<{ results: RecipeSearchResult[] }>(
        `/v1/households/${household.id}/meal-plan/search?q=${encodeURIComponent(q)}`,
      );
      setSearchResults(data.results);
    } catch {
      setSearchResults([]);
    }
  }

  function saveName() {
    const trimmed = nameDraft.trim();
    if (!trimmed || trimmed === meal.name) {
      setMode('details');
      return;
    }
    onEdit({ name: trimmed });
  }

  function replaceWithRecipe(result: RecipeSearchResult) {
    setBusy(true);
    onEdit({ recipeId: result.recipeId, name: result.name });
  }

  return (
    <View style={sheetStyles.overlay}>
      <View style={sheetStyles.sheet}>
        <View style={sheetStyles.header}>
          <Text style={styles.eyebrow}>{meal.mealType}</Text>
          <Pressable accessibilityRole="button" onPress={onClose} style={sheetStyles.closeBtn}>
            <Text style={styles.ghostButtonText}>✕</Text>
          </Pressable>
        </View>

        {mode === 'details' ? (
          <>
            <Text style={sheetStyles.mealName}>{meal.name}</Text>
            <View style={sheetStyles.metaRow}>
              <Text style={styles.subtitle}>
                {t.servings}: {meal.servings}
                {meal.servingsOverridden ? ' (overridden)' : ''}
              </Text>
              {meal.isSpecial ? <Text style={styles.subtitle}> · {t.special}</Text> : null}
            </View>

            <Pressable
              accessibilityRole="button"
              style={styles.primaryButton}
              onPress={() => setMode('editName')}
            >
              <Text style={styles.primaryButtonText}>{t.edit}</Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              style={styles.ghostButton}
              onPress={() => setMode('search')}
            >
              <Text style={styles.ghostButtonText}>{t.searchReplace}</Text>
            </Pressable>

            <ServingsEditor meal={meal} lang={lang} onSave={(servings) => onEdit({ servings })} />

            <Pressable
              accessibilityRole="button"
              style={styles.ghostButton}
              onPress={() => onRegenerate('meal')}
            >
              <Text style={styles.ghostButtonText}>{t.regenerate}</Text>
            </Pressable>
            <Pressable accessibilityRole="button" style={styles.ghostButton} onPress={onSwap}>
              <Text style={styles.ghostButtonText}>{t.swap}</Text>
            </Pressable>
          </>
        ) : mode === 'editName' ? (
          <>
            <Text style={styles.sectionTitle}>{t.edit}</Text>
            <TextInput
              accessibilityLabel={t.mealName}
              style={styles.input}
              value={nameDraft}
              onChangeText={setNameDraft}
              autoFocus
              placeholder={t.mealName}
            />
            <View style={sheetStyles.actions}>
              <Pressable
                accessibilityRole="button"
                style={styles.ghostButton}
                onPress={() => {
                  setNameDraft(meal.name);
                  setMode('details');
                }}
              >
                <Text style={styles.ghostButtonText}>{t.cancel}</Text>
              </Pressable>
              <Pressable accessibilityRole="button" style={styles.primaryButton} onPress={saveName}>
                <Text style={styles.primaryButtonText}>{t.save}</Text>
              </Pressable>
            </View>
          </>
        ) : (
          <>
            <Text style={styles.sectionTitle}>{t.searchReplace}</Text>
            <TextInput
              accessibilityLabel={t.searchPlaceholder}
              style={styles.input}
              value={searchQuery}
              onChangeText={(v) => {
                setSearchQuery(v);
                void runSearch(v);
              }}
              autoFocus
              placeholder={t.searchPlaceholder}
            />
            <ScrollView style={sheetStyles.searchResults}>
              {searchResults.map((result) => (
                <Pressable
                  key={result.recipeId}
                  accessibilityRole="button"
                  style={sheetStyles.searchRow}
                  disabled={busy}
                  onPress={() => replaceWithRecipe(result)}
                >
                  <Text style={styles.mealName}>{result.name}</Text>
                  {result.dietMismatch ? (
                    <Text style={styles.error}> · {t.dietMismatch}</Text>
                  ) : null}
                </Pressable>
              ))}
              {searchResults.length === 0 && searchQuery.trim() ? (
                <Text style={styles.subtitle}>No recipes found.</Text>
              ) : null}
            </ScrollView>
            <Pressable
              accessibilityRole="button"
              style={styles.ghostButton}
              onPress={() => setMode('details')}
            >
              <Text style={styles.ghostButtonText}>{t.cancel}</Text>
            </Pressable>
          </>
        )}
      </View>
    </View>
  );
}

function ServingsEditor({
  meal,
  lang,
  onSave,
}: {
  meal: PlannedMeal;
  lang: Lang;
  onSave: (servings: number) => void;
}) {
  const t = LABELS[lang];
  const [draft, setDraft] = useState(String(meal.servings));
  return (
    <View style={sheetStyles.servingsRow}>
      <Text style={styles.subtitle}>{t.servings}</Text>
      <TextInput
        accessibilityLabel={t.servings}
        style={servingsStyles.input}
        value={draft}
        onChangeText={setDraft}
        keyboardType="numeric"
      />
      <Pressable
        accessibilityRole="button"
        style={styles.ghostButton}
        onPress={() => {
          const n = parseInt(draft, 10);
          if (n > 0 && n !== meal.servings) onSave(n);
        }}
      >
        <Text style={styles.ghostButtonText}>{t.save}</Text>
      </Pressable>
    </View>
  );
}

function ConflictSheet({
  lang,
  current,
  onClose,
  onUseLatest,
}: {
  lang: Lang;
  current: PlannedMeal;
  onClose: () => void;
  onUseLatest: () => void;
}) {
  const t = LABELS[lang];
  return (
    <View style={sheetStyles.overlay}>
      <View style={sheetStyles.sheet}>
        <Text style={styles.cardTitle}>{t.conflictTitle}</Text>
        <Text style={styles.subtitle}>{t.conflictBody}</Text>
        <Card>
          <Text style={styles.mealType}>{current.mealType}</Text>
          <Text style={styles.mealName}>{current.name}</Text>
          <Text style={styles.subtitle}>
            {t.servings}: {current.servings}
          </Text>
        </Card>
        <View style={sheetStyles.actions}>
          <Pressable accessibilityRole="button" style={styles.ghostButton} onPress={onClose}>
            <Text style={styles.ghostButtonText}>{t.cancel}</Text>
          </Pressable>
          <Pressable accessibilityRole="button" style={styles.primaryButton} onPress={onUseLatest}>
            <Text style={styles.primaryButtonText}>{t.useLatest}</Text>
          </Pressable>
        </View>
      </View>
    </View>
  );
}

const dayHeaderStyles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
});

const selectedStyles = StyleSheet.create({
  row: { backgroundColor: '#eff7f4', borderRadius: 8, paddingHorizontal: 8 },
});

const sheetStyles = StyleSheet.create({
  overlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: 'rgba(0,0,0,0.4)',
    justifyContent: 'flex-end',
  },
  sheet: {
    backgroundColor: '#ffffff',
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    padding: 24,
    paddingBottom: 40,
    maxHeight: '85%',
    gap: 12,
  },
  header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  closeBtn: { padding: 8 },
  mealName: { fontSize: 24, fontWeight: '700', color: '#24352f' },
  metaRow: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  actions: { flexDirection: 'row', gap: 8 },
  searchResults: { maxHeight: 200 },
  searchRow: { paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: '#dfe5df' },
  servingsRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
});

const servingsStyles = StyleSheet.create({
  input: {
    width: 60,
    borderWidth: 1,
    borderColor: '#c8d0c8',
    borderRadius: 8,
    padding: 8,
    fontSize: 16,
  },
});
