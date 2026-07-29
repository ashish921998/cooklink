import { useCallback, useEffect, useMemo, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { ApiError, useApi } from '../lib/api';
import type { HouseholdSummary, PlannedMeal, RecipeSearchResult } from '../lib/households';
import {
  Card,
  Chip,
  ErrorNote,
  FadeSlideIn,
  Field,
  Loading,
  Message,
  PressableScale,
  TabScrollView,
  colors,
  fonts,
  mealAccent,
  radius,
  shadow,
  space,
  styles,
} from '../components/ui';

/**
 * The seven-day Weekly Meal Plan destination, shared by the Member and Cook
 * shells (issue 03 / ticket 05). Supports viewing, editing, search-and-replace,
 * swap, regenerate, per-meal serving-count override, stale-conflict
 * confirmation, and Hindi labels — all from either role.
 *
 * The week is presented as a scrollable strip of days with one day's meals
 * below it, rather than all twenty-one meals in a single column: a household
 * asking "what's for dinner" should not have to scroll past four other days to
 * find out. Every day in the plan stays reachable in one tap.
 *
 * The server is the source of truth and authorizes every write; this
 * component only renders authorized rows and surfaces conflicts for fresh
 * confirmation rather than silently overwriting.
 */

type Lang = 'en' | 'hi';

// `en` defines the key set; `hi` is checked against it for completeness by the
// `satisfies` clause, so a missing translation is a compile error without
// restating all 24 key names in a standalone type.
const LABELS = {
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
    thisWeek: 'This week',
    noResults: 'No recipes found.',
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
    thisWeek: 'इस सप्ताह',
    noResults: 'कोई व्यंजन नहीं मिला।',
  },
} satisfies Record<Lang, Record<string, string>>;

/** `2026-07-29` → `{ weekday: 'Wed', day: '29' }`, in the device locale. */
function dayParts(iso: string): { weekday: string; day: string } {
  const date = new Date(`${iso}T00:00:00`);
  return {
    weekday: date.toLocaleDateString(undefined, { weekday: 'short' }),
    day: String(date.getDate()),
  };
}

function longDay(iso: string): string {
  return new Date(`${iso}T00:00:00`).toLocaleDateString(undefined, {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
  });
}

export function MealPlanScreen({ household }: { household: HouseholdSummary }) {
  const api = useApi();
  const lang: Lang = household.defaultLanguage === 'hi' ? 'hi' : 'en';
  const t = LABELS[lang];
  const [meals, setMeals] = useState<PlannedMeal[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editingMeal, setEditingMeal] = useState<PlannedMeal | null>(null);
  const [swapSource, setSwapSource] = useState<PlannedMeal | null>(null);
  const [conflict, setConflict] = useState<{ current: PlannedMeal } | null>(null);
  const [activeDay, setActiveDay] = useState<string | null>(null);

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
  const days = useMemo(() => [...new Set((meals ?? []).map((m) => m.date))].sort(), [meals]);

  // Open on today when the plan covers it, otherwise on the first planned day.
  const selectedDay = activeDay ?? (days.includes(today) ? today : days[0]) ?? null;

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
      if (err instanceof ApiError && err.status === 409) {
        void handleConflict(meal.id);
      } else {
        setError(err instanceof Error ? err.message : 'Could not save the meal.');
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
      if (err instanceof ApiError && err.status === 409) {
        void handleConflict(a.id);
      } else {
        setError(err instanceof Error ? err.message : 'Could not swap the meals.');
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

  if (!meals) return <Loading label={t.mealPlan} />;
  if (error && meals.length === 0) return <Message title={t.mealPlan} body={error} />;

  const dayMeals = meals.filter((m) => m.date === selectedDay);

  return (
    <View style={plan.root}>
      {/* The week strip. Sticky above the day's meals so any day is one tap away. */}
      <View style={plan.stripWrap}>
        <Text style={[styles.eyebrow, plan.stripLabel]}>{t.thisWeek}</Text>
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={plan.strip}
        >
          {days.map((day) => {
            const parts = dayParts(day);
            const isSelected = day === selectedDay;
            const isToday = day === today;
            return (
              <PressableScale
                key={day}
                accessibilityRole="button"
                accessibilityLabel={`${longDay(day)}${isToday ? `, ${t.today}` : ''}`}
                accessibilityState={{ selected: isSelected }}
                style={[plan.day, isSelected && plan.dayOn]}
                onPress={() => setActiveDay(day)}
              >
                <Text style={[plan.dayWeekday, isSelected && plan.dayTextOn]}>{parts.weekday}</Text>
                <Text style={[plan.dayNumber, isSelected && plan.dayTextOn]}>{parts.day}</Text>
                {isToday ? <View style={[plan.dot, isSelected && plan.dotOn]} /> : null}
              </PressableScale>
            );
          })}
        </ScrollView>
      </View>

      <TabScrollView contentContainerStyle={plan.scroll} showsVerticalScrollIndicator={false}>
        {swapSource ? (
          <FadeSlideIn from={10}>
            <View style={plan.swapBar}>
              <Text style={plan.swapText} numberOfLines={2}>
                {t.swapPrompt}: {swapSource.name}
              </Text>
              <PressableScale
                accessibilityRole="button"
                accessibilityLabel={t.swapCancel}
                style={styles.ghostButton}
                onPress={() => setSwapSource(null)}
              >
                <Text style={styles.ghostButtonText}>{t.swapCancel}</Text>
              </PressableScale>
            </View>
          </FadeSlideIn>
        ) : null}

        {error ? <ErrorNote>{error}</ErrorNote> : null}

        {meals.length === 0 ? (
          <Card>
            <Text style={styles.subtitle}>{t.noMeals}</Text>
          </Card>
        ) : (
          <>
            <View style={plan.dayHead}>
              <Text style={plan.dayTitle}>
                {selectedDay === today ? t.today : selectedDay ? longDay(selectedDay) : ''}
              </Text>
              <PressableScale
                accessibilityRole="button"
                accessibilityLabel={t.regenerateDay}
                style={styles.ghostButton}
                onPress={() => void regenerate({ kind: 'day', fromDate: selectedDay ?? today })}
              >
                <Text style={styles.ghostButtonText}>↻ {t.regenerateDay}</Text>
              </PressableScale>
            </View>

            {dayMeals.map((meal, i) => (
              <FadeSlideIn key={meal.id} delay={i * 60}>
                <MealRow
                  meal={meal}
                  lang={lang}
                  isSwapSource={swapSource?.id === meal.id}
                  isSwapTarget={Boolean(swapSource) && swapSource?.id !== meal.id}
                  onOpen={() => setEditingMeal(meal)}
                  onSwapSelect={() => {
                    if (swapSource && swapSource.id !== meal.id) {
                      void swapMeals(swapSource, meal);
                    }
                  }}
                />
              </FadeSlideIn>
            ))}

            <PressableScale
              accessibilityRole="button"
              accessibilityLabel={t.regenerateWeek}
              style={[styles.secondaryButton, plan.weekButton]}
              onPress={() =>
                void regenerate({ kind: 'remaining_week', fromDate: today, includeEdited: false })
              }
            >
              <Text style={styles.secondaryButtonText}>{t.regenerateWeek}</Text>
            </PressableScale>
          </>
        )}
      </TabScrollView>

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
    </View>
  );
}

/**
 * One meal in the selected day. During a swap the row it would swap with is
 * outlined and relabelled, so the second tap's effect is never a guess.
 */
function MealRow({
  meal,
  lang,
  isSwapSource,
  isSwapTarget,
  onOpen,
  onSwapSelect,
}: {
  meal: PlannedMeal;
  lang: Lang;
  isSwapSource: boolean;
  isSwapTarget: boolean;
  onOpen: () => void;
  onSwapSelect: () => void;
}) {
  const t = LABELS[lang];
  const accent = mealAccent(meal.mealType);
  return (
    <PressableScale
      accessibilityRole="button"
      accessibilityLabel={`${meal.mealType} ${meal.name}`}
      accessibilityState={{ selected: isSwapSource }}
      style={[plan.meal, isSwapSource && plan.mealSource, isSwapTarget && plan.mealTarget]}
      onPress={isSwapTarget ? onSwapSelect : onOpen}
    >
      <View style={[plan.mealGlyph, { backgroundColor: accent.tint }]}>
        <Text style={plan.mealGlyphText}>{accent.glyph}</Text>
      </View>
      <View style={plan.mealBody}>
        <Text style={[styles.mealType, { color: accent.label }]}>{meal.mealType}</Text>
        <Text style={plan.mealName}>{meal.name}</Text>
        {meal.servingsOverridden ? (
          <Text style={plan.mealMeta}>
            {meal.servings} {t.servings}
          </Text>
        ) : null}
      </View>
      <View style={plan.mealTail}>
        {meal.isSpecial ? (
          <Chip label={t.special} tint={colors.brandSoft} ink={colors.brand} />
        ) : null}
        <Text style={plan.chevron}>›</Text>
      </View>
    </PressableScale>
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
  const accent = mealAccent(meal.mealType);
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
      {/* Tapping the dimmed area closes the sheet, matching the OS convention. */}
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={t.cancel}
        style={sheetStyles.scrim}
        onPress={onClose}
      />
      <FadeSlideIn from={40} style={sheetStyles.sheetHolder}>
        <View style={sheetStyles.sheet}>
          <View style={sheetStyles.grabber} />

          {mode === 'details' ? (
            <>
              <View style={sheetStyles.hero}>
                <View style={[sheetStyles.heroGlyph, { backgroundColor: accent.tint }]}>
                  <Text style={sheetStyles.heroGlyphText}>{accent.glyph}</Text>
                </View>
                <View style={sheetStyles.heroText}>
                  <Text style={[styles.mealType, { color: accent.label }]}>{meal.mealType}</Text>
                  <Text style={sheetStyles.mealName}>{meal.name}</Text>
                  <Text style={styles.subtitle}>
                    {t.servings}: {meal.servings}
                    {meal.servingsOverridden ? ' · overridden' : ''}
                    {meal.isSpecial ? ` · ${t.special}` : ''}
                  </Text>
                </View>
              </View>

              <PressableScale
                accessibilityRole="button"
                accessibilityLabel={t.searchReplace}
                style={styles.primaryButton}
                onPress={() => setMode('search')}
              >
                <Text style={styles.primaryButtonText}>{t.searchReplace}</Text>
              </PressableScale>

              <View style={sheetStyles.actionGrid}>
                <PressableScale
                  accessibilityRole="button"
                  accessibilityLabel={t.edit}
                  style={[styles.ghostButton, sheetStyles.gridButton]}
                  to={0.94}
                  onPress={() => setMode('editName')}
                >
                  <Text style={[styles.ghostButtonText, sheetStyles.gridButtonText]}>
                    ✎ {t.edit}
                  </Text>
                </PressableScale>
                <PressableScale
                  accessibilityRole="button"
                  accessibilityLabel={t.regenerate}
                  style={[styles.ghostButton, sheetStyles.gridButton]}
                  to={0.94}
                  onPress={() => onRegenerate('meal')}
                >
                  <Text style={[styles.ghostButtonText, sheetStyles.gridButtonText]}>
                    ↻ {t.regenerate}
                  </Text>
                </PressableScale>
                <PressableScale
                  accessibilityRole="button"
                  accessibilityLabel={t.swap}
                  style={[styles.ghostButton, sheetStyles.gridButton]}
                  to={0.94}
                  onPress={onSwap}
                >
                  <Text style={[styles.ghostButtonText, sheetStyles.gridButtonText]}>
                    ⇄ {t.swap}
                  </Text>
                </PressableScale>
              </View>

              <ServingsEditor meal={meal} lang={lang} onSave={(servings) => onEdit({ servings })} />

              <PressableScale
                accessibilityRole="button"
                accessibilityLabel={t.cancel}
                style={sheetStyles.closeRow}
                onPress={onClose}
              >
                <Text style={styles.ghostButtonText}>{t.cancel}</Text>
              </PressableScale>
            </>
          ) : mode === 'editName' ? (
            <>
              <Text style={sheetStyles.sheetTitle}>{t.edit}</Text>
              <Field label={t.mealName}>
                <TextInput
                  accessibilityLabel={t.mealName}
                  style={styles.input}
                  value={nameDraft}
                  onChangeText={setNameDraft}
                  autoFocus
                  placeholder={t.mealName}
                  placeholderTextColor={colors.inkSoft}
                />
              </Field>
              <View style={sheetStyles.actions}>
                <PressableScale
                  accessibilityRole="button"
                  accessibilityLabel={t.cancel}
                  style={[styles.ghostButton, sheetStyles.flexButton]}
                  onPress={() => {
                    setNameDraft(meal.name);
                    setMode('details');
                  }}
                >
                  <Text style={styles.ghostButtonText}>{t.cancel}</Text>
                </PressableScale>
                <PressableScale
                  accessibilityRole="button"
                  accessibilityLabel={t.save}
                  style={[styles.primaryButton, sheetStyles.flexButton]}
                  onPress={saveName}
                >
                  <Text style={styles.primaryButtonText}>{t.save}</Text>
                </PressableScale>
              </View>
            </>
          ) : (
            <>
              <Text style={sheetStyles.sheetTitle}>{t.searchReplace}</Text>
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
                placeholderTextColor={colors.inkSoft}
              />
              <ScrollView style={sheetStyles.searchResults} keyboardShouldPersistTaps="handled">
                {searchResults.map((result) => (
                  <PressableScale
                    key={result.recipeId}
                    accessibilityRole="button"
                    accessibilityLabel={result.name}
                    style={sheetStyles.searchRow}
                    disabled={busy}
                    onPress={() => replaceWithRecipe(result)}
                  >
                    <Text style={sheetStyles.searchName}>{result.name}</Text>
                    {result.dietMismatch ? (
                      <Chip label={t.dietMismatch} tint="#FBEAE6" ink={colors.danger} />
                    ) : null}
                  </PressableScale>
                ))}
                {searchResults.length === 0 && searchQuery.trim() ? (
                  <Text style={styles.subtitle}>{t.noResults}</Text>
                ) : null}
              </ScrollView>
              <PressableScale
                accessibilityRole="button"
                accessibilityLabel={t.cancel}
                style={styles.ghostButton}
                onPress={() => setMode('details')}
              >
                <Text style={styles.ghostButtonText}>{t.cancel}</Text>
              </PressableScale>
            </>
          )}
        </View>
      </FadeSlideIn>
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
  const parsed = parseInt(draft, 10);
  const canSave = parsed > 0 && parsed !== meal.servings;
  return (
    <View style={sheetStyles.servingsRow}>
      <Text style={sheetStyles.servingsLabel}>{t.servings}</Text>
      <TextInput
        accessibilityLabel={t.servings}
        style={[styles.input, sheetStyles.servingsInput]}
        value={draft}
        onChangeText={setDraft}
        keyboardType="numeric"
      />
      <PressableScale
        accessibilityRole="button"
        accessibilityLabel={t.save}
        style={[styles.ghostButton, !canSave && styles.disabled]}
        disabled={!canSave}
        onPress={() => {
          if (canSave) onSave(parsed);
        }}
      >
        <Text style={styles.ghostButtonText}>{t.save}</Text>
      </PressableScale>
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
  const accent = mealAccent(current.mealType);
  return (
    <View style={sheetStyles.overlay}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={t.cancel}
        style={sheetStyles.scrim}
        onPress={onClose}
      />
      <FadeSlideIn from={40} style={sheetStyles.sheetHolder}>
        <View style={sheetStyles.sheet}>
          <View style={sheetStyles.grabber} />
          <Text style={sheetStyles.sheetTitle}>{t.conflictTitle}</Text>
          <Text style={styles.subtitle}>{t.conflictBody}</Text>
          <View style={sheetStyles.conflictCard}>
            <View style={[plan.mealGlyph, { backgroundColor: accent.tint }]}>
              <Text style={plan.mealGlyphText}>{accent.glyph}</Text>
            </View>
            <View style={plan.mealBody}>
              <Text style={[styles.mealType, { color: accent.label }]}>{current.mealType}</Text>
              <Text style={plan.mealName}>{current.name}</Text>
              <Text style={plan.mealMeta}>
                {t.servings}: {current.servings}
              </Text>
            </View>
          </View>
          <View style={sheetStyles.actions}>
            <PressableScale
              accessibilityRole="button"
              accessibilityLabel={t.cancel}
              style={[styles.ghostButton, sheetStyles.flexButton]}
              onPress={onClose}
            >
              <Text style={styles.ghostButtonText}>{t.cancel}</Text>
            </PressableScale>
            <PressableScale
              accessibilityRole="button"
              accessibilityLabel={t.useLatest}
              style={[styles.primaryButton, sheetStyles.flexButton]}
              onPress={onUseLatest}
            >
              <Text style={styles.primaryButtonText}>{t.useLatest}</Text>
            </PressableScale>
          </View>
        </View>
      </FadeSlideIn>
    </View>
  );
}

const plan = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.surface },

  stripWrap: { paddingTop: space.sm, paddingBottom: space.md, gap: space.sm },
  stripLabel: { paddingHorizontal: space.xl },
  strip: { paddingHorizontal: space.xl, gap: space.sm },
  day: {
    width: 54,
    minHeight: 66,
    borderRadius: radius.md,
    backgroundColor: colors.card,
    borderWidth: 1.5,
    borderColor: colors.border,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 1,
  },
  dayOn: { backgroundColor: colors.accent, borderColor: colors.accent, ...shadow.soft },
  dayWeekday: {
    fontSize: 11,
    fontWeight: '800',
    color: colors.inkSoft,
    textTransform: 'uppercase',
    letterSpacing: 0.6,
  },
  dayNumber: { fontFamily: fonts.display, fontSize: 20, fontWeight: '700', color: colors.ink },
  dayTextOn: { color: '#FFFFFF' },
  dot: { width: 5, height: 5, borderRadius: 3, backgroundColor: colors.brand },
  dotOn: { backgroundColor: colors.turmeric },

  scroll: { paddingHorizontal: space.xl, paddingBottom: space.xxl, gap: space.md },
  dayHead: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: space.sm,
  },
  dayTitle: {
    flex: 1,
    fontFamily: fonts.display,
    fontSize: 23,
    fontWeight: '700',
    color: colors.ink,
  },

  swapBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    borderRadius: radius.md,
    backgroundColor: colors.brandSoft,
    padding: space.lg,
  },
  swapText: { flex: 1, fontSize: 14, lineHeight: 20, color: colors.brand, fontWeight: '700' },

  meal: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.lg,
    borderRadius: radius.lg,
    backgroundColor: colors.card,
    padding: space.lg,
    borderWidth: 2,
    borderColor: 'transparent',
    ...shadow.soft,
  },
  mealSource: { borderColor: colors.brand, backgroundColor: colors.brandSoft },
  mealTarget: { borderColor: colors.accent, borderStyle: 'dashed' },
  mealGlyph: {
    width: 50,
    height: 50,
    borderRadius: 25,
    alignItems: 'center',
    justifyContent: 'center',
  },
  mealGlyphText: { fontSize: 24 },
  mealBody: { flex: 1, gap: 3 },
  mealName: { fontFamily: fonts.display, fontSize: 18, lineHeight: 23, color: colors.ink },
  mealMeta: { fontSize: 12, color: colors.inkSoft },
  mealTail: { alignItems: 'flex-end', gap: space.xs },
  chevron: { fontSize: 22, color: colors.inkSoft, lineHeight: 24 },

  weekButton: { marginTop: space.sm },
});

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
  sheetHolder: { width: '100%' },
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
  sheetTitle: { fontFamily: fonts.display, fontSize: 24, fontWeight: '700', color: colors.ink },

  hero: { flexDirection: 'row', alignItems: 'center', gap: space.lg },
  heroGlyph: {
    width: 64,
    height: 64,
    borderRadius: 32,
    alignItems: 'center',
    justifyContent: 'center',
  },
  heroGlyphText: { fontSize: 32 },
  heroText: { flex: 1, gap: 3 },
  mealName: {
    fontFamily: fonts.display,
    fontSize: 25,
    lineHeight: 30,
    fontWeight: '700',
    color: colors.ink,
  },

  actionGrid: { flexDirection: 'row', gap: space.sm },
  // Three buttons share one row, so the label sets smaller than a full-width
  // ghost button to stay on a single line at the longest translation.
  gridButton: { flex: 1, paddingHorizontal: space.xs },
  gridButtonText: { fontSize: 13 },
  actions: { flexDirection: 'row', gap: space.sm },
  flexButton: { flex: 1 },
  closeRow: {
    alignItems: 'center',
    paddingVertical: space.md,
    minHeight: 44,
    justifyContent: 'center',
  },

  searchResults: { maxHeight: 260 },
  searchRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: space.sm,
    minHeight: 48,
    paddingVertical: space.md,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  searchName: { flex: 1, fontFamily: fonts.display, fontSize: 17, color: colors.ink },

  servingsRow: { flexDirection: 'row', alignItems: 'center', gap: space.md },
  servingsLabel: { flex: 1, fontSize: 15, fontWeight: '700', color: colors.ink },
  servingsInput: { width: 74, textAlign: 'center', paddingVertical: 12 },

  conflictCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.lg,
    borderRadius: radius.lg,
    backgroundColor: colors.card,
    padding: space.lg,
  },
});
