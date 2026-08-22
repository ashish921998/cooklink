import { useCallback, useEffect, useMemo, useState } from 'react';
import { Image, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ApiError, useApi } from '../lib/api';
import type { HouseholdSummary, PlannedMeal, RecipeSearchResult } from '../lib/households';
import { mealImage } from '../lib/meal-images';
import {
  Card,
  Chip,
  ErrorNote,
  FadeSlideIn,
  Field,
  Loading,
  Message,
  PotLoader,
  PressableScale,
  TabScrollView,
  colors,
  fonts,
  mealAccent,
  radius,
  space,
  styles,
} from '../components/design-system';
import { Text, TextInput } from '../components/Typography';

/**
 * The seven-day Weekly Meal Plan destination, shared by the Member and Cook
 * shells (issue 03 / ticket 05). Supports viewing, editing, search-and-replace,
 * swap, regenerate, per-meal serving-count override, stale-conflict
 * confirmation, and Hindi labels — all from either role.
 *
 * The week is a complete vertical timeline with a compact day navigator. A
 * selected day moves to the top without hiding the rest of the household plan,
 * so the current meal is quick to reach and the week remains scannable.
 *
 * The server is the source of truth and authorizes every write; this
 * component only renders authorized rows and surfaces conflicts for fresh
 * confirmation rather than silently overwriting.
 */

type Lang = 'en' | 'hi';

const RECIPE_HERO_ACTION_BACKGROUND = 'rgba(63,55,45,0.58)';
const RECIPE_HERO_ACTION_SHADOW = '#1A120C';

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

function keyedByOccurrence<T>(items: readonly T[], identity: (item: T) => string) {
  const counts = new Map<string, number>();
  return items.map((item) => {
    const base = identity(item);
    const occurrence = counts.get(base) ?? 0;
    counts.set(base, occurrence + 1);
    return { item, key: `${base}-${occurrence}` };
  });
}

type RecipeDetail = {
  id: string;
  name: string;
  nameHi: string | null;
  steps: string[];
  stepsHi: string[] | null;
  provenance: 'verified' | 'ai_draft';
  servings: number;
  ingredients: { name: string; display: string; dependable: boolean }[];
};

export function MealPlanScreen({
  household,
  onRecipeOpenChange,
  includeTopSafeArea = true,
}: {
  household: HouseholdSummary;
  onRecipeOpenChange?: (open: boolean) => void;
  /** False when a parent header already owns the device's top safe area. */
  includeTopSafeArea?: boolean;
}) {
  const api = useApi();
  const insets = useSafeAreaInsets();
  const lang: Lang = household.defaultLanguage === 'hi' ? 'hi' : 'en';
  const t = LABELS[lang];
  const [meals, setMeals] = useState<PlannedMeal[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editingMeal, setEditingMeal] = useState<PlannedMeal | null>(null);
  const [viewingMeal, setViewingMeal] = useState<PlannedMeal | null>(null);
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

  const openRecipe = useCallback(
    (meal: PlannedMeal) => {
      setViewingMeal(meal);
      onRecipeOpenChange?.(true);
    },
    [onRecipeOpenChange],
  );

  const closeRecipe = useCallback(() => {
    setViewingMeal(null);
    onRecipeOpenChange?.(false);
  }, [onRecipeOpenChange]);

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

  const editMeal = useCallback(
    async (meal: PlannedMeal, patch: Partial<PlannedMeal>) => {
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
    },
    [api, handleConflict, household.id, mergeMeal],
  );

  const swapMeals = useCallback(
    async (a: PlannedMeal, b: PlannedMeal) => {
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
    },
    [api, handleConflict, household.id, mergeSwapped],
  );

  const regenerate = useCallback(
    async (opts: {
      kind: 'meal' | 'day' | 'remaining_week';
      mealId?: string;
      fromDate?: string;
      includeEdited?: boolean;
    }) => {
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
    },
    [api, household.id],
  );

  const stripWrapStyle = useMemo(
    () => ({ paddingTop: (includeTopSafeArea ? insets.top : 0) + space.sm }),
    [includeTopSafeArea, insets.top],
  );
  const cancelSwap = useCallback(() => setSwapSource(null), []);
  const regenerateWeek = useCallback(
    () => void regenerate({ kind: 'remaining_week', fromDate: today, includeEdited: false }),
    [regenerate, today],
  );
  const changeViewedMeal = useCallback(() => {
    if (!viewingMeal) return;
    setEditingMeal(viewingMeal);
    closeRecipe();
  }, [closeRecipe, viewingMeal]);
  const closeMealEditor = useCallback(() => setEditingMeal(null), []);
  const editCurrentMeal = useCallback(
    (patch: Partial<PlannedMeal>) => {
      if (editingMeal) void editMeal(editingMeal, patch);
    },
    [editMeal, editingMeal],
  );
  const regenerateCurrentMeal = useCallback(
    (kind: 'meal') => {
      if (kind === 'meal' && editingMeal) {
        void regenerate({ kind: 'meal', mealId: editingMeal.id });
      }
    },
    [editingMeal, regenerate],
  );
  const startSwap = useCallback(() => {
    if (!editingMeal) return;
    setSwapSource(editingMeal);
    setEditingMeal(null);
  }, [editingMeal]);
  const closeConflict = useCallback(() => setConflict(null), []);
  const useLatestConflict = useCallback(() => {
    if (!conflict) return;
    setEditingMeal(conflict.current);
    setConflict(null);
  }, [conflict]);

  if (!meals) return <Loading label={t.mealPlan} />;
  if (error && meals.length === 0) return <Message title={t.mealPlan} body={error} />;

  const orderedDays = selectedDay
    ? [selectedDay, ...days.filter((day) => day !== selectedDay)]
    : days;
  const modalOpen = Boolean(viewingMeal || editingMeal || conflict);

  return (
    <View style={plan.root}>
      <View
        style={plan.content}
        accessibilityElementsHidden={modalOpen}
        importantForAccessibility={modalOpen ? 'no-hide-descendants' : 'auto'}
      >
        {/* Selecting a day brings its section to the top while keeping the full week scannable. */}
        <View style={StyleSheet.compose(plan.stripWrap, stripWrapStyle)}>
          <Text style={STRIP_LABEL_STYLE}>{t.thisWeek}</Text>
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={plan.strip}
          >
            {days.map((day) => (
              <DayPickerButton
                key={day}
                day={day}
                isSelected={day === selectedDay}
                isToday={day === today}
                todayLabel={t.today}
                onSelect={setActiveDay}
              />
            ))}
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
                  onPress={cancelSwap}
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
              <View style={plan.titleBlock}>
                <Text style={plan.planTitle}>Seven days, one clear plan.</Text>
                <Text style={plan.planSubtitle}>
                  Tap a meal for the recipe. Use Change when you want a different plan.
                </Text>
              </View>

              {orderedDays.map((day, dayIndex) => (
                <DayPlanSection
                  key={day}
                  day={day}
                  dayIndex={dayIndex}
                  meals={meals}
                  lang={lang}
                  today={today}
                  todayLabel={t.today}
                  regenerateDayLabel={t.regenerateDay}
                  swapSource={swapSource}
                  onRegenerate={regenerate}
                  onOpenMeal={openRecipe}
                  onChangeMeal={setEditingMeal}
                  onSwapMeals={swapMeals}
                />
              ))}

              <PressableScale
                accessibilityRole="button"
                accessibilityLabel={t.regenerateWeek}
                style={WEEK_BUTTON_STYLE}
                onPress={regenerateWeek}
              >
                <Text style={styles.secondaryButtonText}>{t.regenerateWeek}</Text>
              </PressableScale>
            </>
          )}
        </TabScrollView>
      </View>

      {viewingMeal ? (
        <RecipeDetailOverlay
          meal={viewingMeal}
          household={household}
          lang={lang}
          onClose={closeRecipe}
          onChange={changeViewedMeal}
        />
      ) : null}

      {editingMeal ? (
        <MealDetailSheet
          meal={editingMeal}
          household={household}
          lang={lang}
          onClose={closeMealEditor}
          onEdit={editCurrentMeal}
          onRegenerate={regenerateCurrentMeal}
          onSwap={startSwap}
        />
      ) : null}

      {conflict ? (
        <ConflictSheet
          lang={lang}
          current={conflict.current}
          onClose={closeConflict}
          onUseLatest={useLatestConflict}
        />
      ) : null}
    </View>
  );
}

function DayPickerButton({
  day,
  isSelected,
  isToday,
  todayLabel,
  onSelect,
}: {
  day: string;
  isSelected: boolean;
  isToday: boolean;
  todayLabel: string;
  onSelect: (day: string) => void;
}) {
  const parts = dayParts(day);
  const accessibilityState = useMemo(() => ({ selected: isSelected }), [isSelected]);
  const onPress = useCallback(() => onSelect(day), [day, onSelect]);
  const dayStyle = StyleSheet.compose(plan.day, isSelected ? plan.dayOn : undefined);
  const weekdayStyle = StyleSheet.compose(plan.dayWeekday, isSelected ? plan.dayTextOn : undefined);
  const dayNumberStyle = StyleSheet.compose(
    plan.dayNumber,
    isSelected ? plan.dayTextOn : undefined,
  );
  const dotStyle = StyleSheet.compose(plan.dot, isSelected ? plan.dotOn : undefined);

  return (
    <PressableScale
      accessibilityRole="button"
      accessibilityLabel={`${longDay(day)}${isToday ? `, ${todayLabel}` : ''}`}
      accessibilityState={accessibilityState}
      style={dayStyle}
      onPress={onPress}
    >
      <Text style={weekdayStyle}>{parts.weekday}</Text>
      <Text style={dayNumberStyle}>{parts.day}</Text>
      {isToday ? <View style={dotStyle} /> : null}
    </PressableScale>
  );
}

type RegenerateOptions = {
  kind: 'meal' | 'day' | 'remaining_week';
  mealId?: string;
  fromDate?: string;
  includeEdited?: boolean;
};

function DayPlanSection({
  day,
  dayIndex,
  meals,
  lang,
  today,
  todayLabel,
  regenerateDayLabel,
  swapSource,
  onRegenerate,
  onOpenMeal,
  onChangeMeal,
  onSwapMeals,
}: {
  day: string;
  dayIndex: number;
  meals: PlannedMeal[];
  lang: Lang;
  today: string;
  todayLabel: string;
  regenerateDayLabel: string;
  swapSource: PlannedMeal | null;
  onRegenerate: (options: RegenerateOptions) => Promise<void>;
  onOpenMeal: (meal: PlannedMeal) => void;
  onChangeMeal: (meal: PlannedMeal) => void;
  onSwapMeals: (source: PlannedMeal, target: PlannedMeal) => Promise<void>;
}) {
  const dayMeals = meals.filter((meal) => meal.date === day);
  const regenerateDay = useCallback(
    () => void onRegenerate({ kind: 'day', fromDate: day }),
    [day, onRegenerate],
  );

  return (
    <View style={plan.daySection}>
      <View style={plan.dayHead}>
        <View style={plan.dayHeadingText}>
          <Text style={plan.dayKicker}>{day === today ? todayLabel : dayParts(day).weekday}</Text>
          <Text style={plan.dayTitle}>{longDay(day)}</Text>
        </View>
        {day >= today ? (
          <PressableScale
            accessibilityRole="button"
            accessibilityLabel={`${regenerateDayLabel}, ${longDay(day)}`}
            style={plan.dayAction}
            onPress={regenerateDay}
          >
            <Text style={plan.dayActionText}>↻</Text>
          </PressableScale>
        ) : null}
      </View>

      {dayMeals.map((meal, mealIndex) => (
        <FadeSlideIn key={meal.id} delay={Math.min(dayIndex * 30 + mealIndex * 35, 240)}>
          <MealRow
            meal={meal}
            lang={lang}
            swapSource={swapSource}
            onOpenMeal={onOpenMeal}
            onChangeMeal={onChangeMeal}
            onSwapMeals={onSwapMeals}
          />
        </FadeSlideIn>
      ))}
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
  swapSource,
  onOpenMeal,
  onChangeMeal,
  onSwapMeals,
}: {
  meal: PlannedMeal;
  lang: Lang;
  swapSource: PlannedMeal | null;
  onOpenMeal: (meal: PlannedMeal) => void;
  onChangeMeal: (meal: PlannedMeal) => void;
  onSwapMeals: (source: PlannedMeal, target: PlannedMeal) => Promise<void>;
}) {
  const t = LABELS[lang];
  const isSwapSource = swapSource?.id === meal.id;
  const isSwapTarget = Boolean(swapSource) && !isSwapSource;
  const accent = useMemo(() => mealAccent(meal.mealType), [meal.mealType]);
  const image = mealImage(meal.name, meal.mealType);
  const accessibilityState = useMemo(() => ({ selected: isSwapSource }), [isSwapSource]);
  const rowStyle = useMemo(
    () => [plan.meal, isSwapSource && plan.mealSource, isSwapTarget && plan.mealTarget],
    [isSwapSource, isSwapTarget],
  );
  const mealTypeStyle = useMemo(() => ({ color: accent.label }), [accent.label]);
  const openMeal = useCallback(() => onOpenMeal(meal), [meal, onOpenMeal]);
  const changeMeal = useCallback(() => onChangeMeal(meal), [meal, onChangeMeal]);
  const swapMeals = useCallback(() => {
    if (swapSource && swapSource.id !== meal.id) void onSwapMeals(swapSource, meal);
  }, [meal, onSwapMeals, swapSource]);
  return (
    <PressableScale
      accessibilityRole="button"
      accessibilityLabel={`${meal.mealType} ${meal.name}`}
      accessibilityState={accessibilityState}
      style={rowStyle}
      onPress={isSwapTarget ? swapMeals : openMeal}
    >
      <Image source={image.source} style={plan.mealImage} resizeMode="cover" />
      <View style={plan.mealBody}>
        <Text style={StyleSheet.compose(styles.mealType, mealTypeStyle)}>{meal.mealType}</Text>
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
        {!isSwapTarget ? (
          <PressableScale
            accessibilityRole="button"
            accessibilityLabel={`Change ${meal.name}`}
            style={plan.changeButton}
            onPress={changeMeal}
          >
            <Text style={plan.changeButtonText}>Change</Text>
          </PressableScale>
        ) : (
          <Text style={plan.chevron}>↔</Text>
        )}
      </View>
    </PressableScale>
  );
}

function RecipeDetailOverlay({
  meal,
  household,
  lang,
  onClose,
  onChange,
}: {
  meal: PlannedMeal;
  household: HouseholdSummary;
  lang: Lang;
  onClose: () => void;
  onChange: () => void;
}) {
  const api = useApi();
  const insets = useSafeAreaInsets();
  const image = mealImage(meal.name, meal.mealType);
  const [recipe, setRecipe] = useState<RecipeDetail | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setRecipe(undefined);
    setError(null);
    api<{ recipe: RecipeDetail | null }>(
      `/v1/households/${household.id}/meal-plan/meals/${meal.id}/recipe`,
    )
      .then((data) => setRecipe(data.recipe))
      .catch((err: unknown) => {
        setRecipe(null);
        setError(err instanceof Error ? err.message : 'Could not load the recipe.');
      });
  }, [api, household.id, meal.id]);

  const steps = lang === 'hi' && recipe?.stepsHi?.length ? recipe.stepsHi : recipe?.steps;
  const scrollContentStyle = useMemo(
    () => [recipeStyles.scroll, { paddingBottom: Math.max(insets.bottom, 20) }],
    [insets.bottom],
  );
  const heroActionStyle = useMemo(
    () => [recipeStyles.heroAction, recipeStyles.backAction, { top: insets.top + 12 }],
    [insets.top],
  );
  const keyedIngredients = useMemo(
    () =>
      keyedByOccurrence(
        recipe?.ingredients ?? [],
        (ingredient) => `${ingredient.name}-${ingredient.display}-${ingredient.dependable}`,
      ),
    [recipe?.ingredients],
  );
  const keyedSteps = useMemo(() => keyedByOccurrence(steps ?? [], (step) => step), [steps]);

  return (
    <View style={recipeStyles.overlay} accessibilityViewIsModal importantForAccessibility="yes">
      <ScrollView
        style={recipeStyles.scroller}
        contentContainerStyle={scrollContentStyle}
        contentInsetAdjustmentBehavior="never"
        showsVerticalScrollIndicator={false}
      >
        <View style={recipeStyles.hero}>
          <Image source={image.source} style={recipeStyles.image} resizeMode="cover" />
          <PressableScale
            accessibilityRole="button"
            accessibilityLabel="Back to meal plan"
            accessibilityHint="Closes this recipe"
            style={heroActionStyle}
            onPress={onClose}
          >
            <Text style={recipeStyles.backText}>‹</Text>
          </PressableScale>
        </View>
        <View style={recipeStyles.body}>
          <View style={recipeStyles.topline}>
            <Text style={recipeStyles.mealType}>{meal.mealType}</Text>
            {image.representative ? (
              <Text style={recipeStyles.suggestion}>Serving suggestion</Text>
            ) : null}
          </View>
          <Text style={recipeStyles.name}>{meal.name}</Text>

          <View style={recipeStyles.metadata}>
            <View style={recipeStyles.metadataCell}>
              <Text style={recipeStyles.metadataLabel}>MEAL</Text>
              <Text style={METADATA_VALUE_CAPITALIZED_STYLE}>{meal.mealType}</Text>
            </View>
            <View style={METADATA_CELL_DIVIDER_STYLE}>
              <Text style={recipeStyles.metadataLabel}>SERVES</Text>
              <Text style={recipeStyles.metadataValue}>{recipe?.servings ?? meal.servings}</Text>
            </View>
            <View style={METADATA_CELL_DIVIDER_STYLE}>
              <Text style={recipeStyles.metadataLabel}>RECIPE</Text>
              <Text style={recipeStyles.metadataValue}>
                {recipe?.provenance === 'verified' ? 'Ready' : recipe ? 'Draft' : '—'}
              </Text>
            </View>
          </View>

          <View style={recipeStyles.authorRow}>
            <View style={recipeStyles.authorAvatar}>
              <Text style={recipeStyles.authorInitial}>C</Text>
            </View>
            <View style={recipeStyles.authorCopy}>
              <Text style={recipeStyles.authorLabel}>SOURCE</Text>
              <Text style={recipeStyles.authorName}>
                {recipe?.provenance === 'verified'
                  ? 'Verified Cooklink recipe'
                  : recipe
                    ? 'AI-assisted draft'
                    : 'Cooklink recipe'}
              </Text>
            </View>
          </View>

          {error ? <ErrorNote>{error}</ErrorNote> : null}
          {recipe === undefined ? (
            <PotLoader label="Opening recipe" />
          ) : recipe === null ? (
            <View style={recipeStyles.missing}>
              <Text style={recipeStyles.missingTitle}>Recipe details are still being prepared</Text>
              <Text style={recipeStyles.missingBody}>
                This planned meal has a name but no dependable ingredient list or cooking steps yet.
                Cooklink will not invent them.
              </Text>
            </View>
          ) : (
            <>
              <View style={recipeStyles.section}>
                <View style={recipeStyles.sectionHeading}>
                  <Text style={recipeStyles.sectionTitle}>Ingredients</Text>
                  <Text style={recipeStyles.sectionCount}>
                    {recipe.ingredients.length} {recipe.ingredients.length === 1 ? 'item' : 'items'}
                  </Text>
                </View>
                <View style={recipeStyles.ingredientList}>
                  {keyedIngredients.map(({ item: ingredient, key }) => (
                    <View key={key} style={recipeStyles.ingredientRow}>
                      <View style={recipeStyles.ingredientBullet} />
                      <Text style={recipeStyles.ingredientText}>{ingredient.display}</Text>
                    </View>
                  ))}
                </View>
              </View>

              <View style={recipeStyles.section}>
                <Text style={recipeStyles.sectionTitle}>Method</Text>
                {keyedSteps.map(({ item: step, key }, index) => (
                  <View
                    key={key}
                    style={StyleSheet.compose(
                      recipeStyles.step,
                      index < keyedSteps.length - 1 ? recipeStyles.stepBorder : undefined,
                    )}
                  >
                    <Text style={recipeStyles.stepNumber}>{index + 1}</Text>
                    <Text style={recipeStyles.stepText}>{step}</Text>
                  </View>
                ))}
              </View>
            </>
          )}

          <PressableScale
            accessibilityRole="button"
            accessibilityLabel={`Change ${meal.name}`}
            style={recipeStyles.changeMeal}
            onPress={onChange}
          >
            <Text style={recipeStyles.changeMealText}>Change meal</Text>
            <Text style={recipeStyles.changeMealArrow}>›</Text>
          </PressableScale>
        </View>
      </ScrollView>
    </View>
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
  const accent = useMemo(() => mealAccent(meal.mealType), [meal.mealType]);
  const [mode, setMode] = useState<'details' | 'editName' | 'search'>('details');
  const [nameDraft, setNameDraft] = useState(meal.name);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<RecipeSearchResult[]>([]);
  const [busy, setBusy] = useState(false);
  const api = useApi();

  const runSearch = useCallback(
    async (q: string) => {
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
    },
    [api, household.id],
  );

  const saveName = useCallback(() => {
    const trimmed = nameDraft.trim();
    if (!trimmed || trimmed === meal.name) {
      setMode('details');
      return;
    }
    onEdit({ name: trimmed });
  }, [meal.name, nameDraft, onEdit]);

  const replaceWithRecipe = useCallback(
    (result: RecipeSearchResult) => {
      setBusy(true);
      onEdit({ recipeId: result.recipeId, name: result.name });
    },
    [onEdit],
  );
  const heroGlyphStyle = useMemo(() => ({ backgroundColor: accent.tint }), [accent.tint]);
  const mealTypeStyle = useMemo(() => ({ color: accent.label }), [accent.label]);
  const showSearch = useCallback(() => setMode('search'), []);
  const showEditName = useCallback(() => setMode('editName'), []);
  const regenerateMeal = useCallback(() => onRegenerate('meal'), [onRegenerate]);
  const saveServings = useCallback((servings: number) => onEdit({ servings }), [onEdit]);
  const cancelEditName = useCallback(() => {
    setNameDraft(meal.name);
    setMode('details');
  }, [meal.name]);
  const handleSearchChange = useCallback(
    (value: string) => {
      setSearchQuery(value);
      void runSearch(value);
    },
    [runSearch],
  );
  const showDetails = useCallback(() => setMode('details'), []);

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
                <View style={StyleSheet.compose(sheetStyles.heroGlyph, heroGlyphStyle)}>
                  <Text style={sheetStyles.heroGlyphText}>{accent.glyph}</Text>
                </View>
                <View style={sheetStyles.heroText}>
                  <Text style={StyleSheet.compose(styles.mealType, mealTypeStyle)}>
                    {meal.mealType}
                  </Text>
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
                onPress={showSearch}
              >
                <Text style={styles.primaryButtonText}>{t.searchReplace}</Text>
              </PressableScale>

              <View style={sheetStyles.actionGrid}>
                <PressableScale
                  accessibilityRole="button"
                  accessibilityLabel={t.edit}
                  style={GHOST_GRID_BUTTON_STYLE}
                  to={0.94}
                  onPress={showEditName}
                >
                  <Text style={GHOST_GRID_BUTTON_TEXT_STYLE}>✎ {t.edit}</Text>
                </PressableScale>
                <PressableScale
                  accessibilityRole="button"
                  accessibilityLabel={t.regenerate}
                  style={GHOST_GRID_BUTTON_STYLE}
                  to={0.94}
                  onPress={regenerateMeal}
                >
                  <Text style={GHOST_GRID_BUTTON_TEXT_STYLE}>↻ {t.regenerate}</Text>
                </PressableScale>
                <PressableScale
                  accessibilityRole="button"
                  accessibilityLabel={t.swap}
                  style={GHOST_GRID_BUTTON_STYLE}
                  to={0.94}
                  onPress={onSwap}
                >
                  <Text style={GHOST_GRID_BUTTON_TEXT_STYLE}>⇄ {t.swap}</Text>
                </PressableScale>
              </View>

              <ServingsEditor meal={meal} lang={lang} onSave={saveServings} />

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
                  style={GHOST_FLEX_BUTTON_STYLE}
                  onPress={cancelEditName}
                >
                  <Text style={styles.ghostButtonText}>{t.cancel}</Text>
                </PressableScale>
                <PressableScale
                  accessibilityRole="button"
                  accessibilityLabel={t.save}
                  style={PRIMARY_FLEX_BUTTON_STYLE}
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
                onChangeText={handleSearchChange}
                autoFocus
                placeholder={t.searchPlaceholder}
                placeholderTextColor={colors.inkSoft}
              />
              <ScrollView style={sheetStyles.searchResults} keyboardShouldPersistTaps="handled">
                {searchResults.map((result) => (
                  <SearchResultRow
                    key={result.recipeId}
                    result={result}
                    dietMismatchLabel={t.dietMismatch}
                    disabled={busy}
                    onSelect={replaceWithRecipe}
                  />
                ))}
                {searchResults.length === 0 && searchQuery.trim() ? (
                  <Text style={styles.subtitle}>{t.noResults}</Text>
                ) : null}
              </ScrollView>
              <PressableScale
                accessibilityRole="button"
                accessibilityLabel={t.cancel}
                style={styles.ghostButton}
                onPress={showDetails}
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

function SearchResultRow({
  result,
  dietMismatchLabel,
  disabled,
  onSelect,
}: {
  result: RecipeSearchResult;
  dietMismatchLabel: string;
  disabled: boolean;
  onSelect: (result: RecipeSearchResult) => void;
}) {
  const onPress = useCallback(() => onSelect(result), [onSelect, result]);
  return (
    <PressableScale
      accessibilityRole="button"
      accessibilityLabel={result.name}
      style={sheetStyles.searchRow}
      disabled={disabled}
      onPress={onPress}
    >
      <Text style={sheetStyles.searchName}>{result.name}</Text>
      {result.dietMismatch ? (
        <Chip label={dietMismatchLabel} tint={colors.dangerSoft} ink={colors.danger} />
      ) : null}
    </PressableScale>
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
  const save = useCallback(() => {
    if (canSave) onSave(parsed);
  }, [canSave, onSave, parsed]);
  const saveButtonStyle = StyleSheet.compose(
    styles.ghostButton,
    canSave ? undefined : styles.disabled,
  );
  return (
    <View style={sheetStyles.servingsRow}>
      <Text style={sheetStyles.servingsLabel}>{t.servings}</Text>
      <TextInput
        accessibilityLabel={t.servings}
        style={SERVINGS_INPUT_STYLE}
        value={draft}
        onChangeText={setDraft}
        keyboardType="numeric"
      />
      <PressableScale
        accessibilityRole="button"
        accessibilityLabel={t.save}
        style={saveButtonStyle}
        disabled={!canSave}
        onPress={save}
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
  const accent = useMemo(() => mealAccent(current.mealType), [current.mealType]);
  const image = mealImage(current.name, current.mealType);
  const mealTypeStyle = useMemo(() => ({ color: accent.label }), [accent.label]);
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
            <Image source={image.source} style={plan.mealImage} resizeMode="cover" />
            <View style={plan.mealBody}>
              <Text style={StyleSheet.compose(styles.mealType, mealTypeStyle)}>
                {current.mealType}
              </Text>
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
              style={GHOST_FLEX_BUTTON_STYLE}
              onPress={onClose}
            >
              <Text style={styles.ghostButtonText}>{t.cancel}</Text>
            </PressableScale>
            <PressableScale
              accessibilityRole="button"
              accessibilityLabel={t.useLatest}
              style={PRIMARY_FLEX_BUTTON_STYLE}
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
  content: { flex: 1 },

  stripWrap: {
    paddingTop: space.sm,
    paddingBottom: space.md,
    gap: space.sm,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  stripLabel: { paddingHorizontal: space.xl },
  strip: { width: '100%', paddingHorizontal: space.lg, gap: space.xs },
  day: {
    flex: 1,
    minWidth: 0,
    minHeight: 46,
    paddingHorizontal: space.xs,
    borderRadius: radius.pill,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 0,
  },
  dayOn: { backgroundColor: colors.accent, borderColor: colors.accent },
  dayWeekday: {
    fontSize: 11,
    fontWeight: '800',
    color: colors.inkSoft,
    textTransform: 'uppercase',
    letterSpacing: 0.6,
  },
  dayNumber: { fontFamily: fonts.display, fontSize: 17, fontWeight: '700', color: colors.ink },
  dayTextOn: { color: colors.card },
  dot: { width: 5, height: 5, borderRadius: 3, backgroundColor: colors.brand },
  dotOn: { backgroundColor: colors.turmeric },

  scroll: { paddingHorizontal: space.xl, paddingBottom: space.xxl, gap: space.lg },
  titleBlock: { gap: space.xs, paddingTop: space.sm, paddingBottom: space.sm },
  planTitle: {
    fontFamily: fonts.display,
    fontSize: 29,
    lineHeight: 34,
    fontWeight: '700',
    color: colors.ink,
    letterSpacing: -0.9,
  },
  planSubtitle: { fontSize: 14, lineHeight: 21, color: colors.inkSoft },
  daySection: { gap: space.sm, marginTop: space.md, paddingTop: space.sm },
  dayHead: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: space.sm,
  },
  dayHeadingText: { flex: 1, gap: 2 },
  dayKicker: {
    fontSize: 11,
    fontWeight: '900',
    color: colors.brand,
    textTransform: 'uppercase',
    letterSpacing: 1.1,
  },
  dayTitle: {
    fontFamily: fonts.display,
    fontSize: 21,
    lineHeight: 25,
    fontWeight: '700',
    color: colors.ink,
  },
  dayAction: {
    width: 44,
    height: 44,
    borderRadius: radius.sm,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.border,
  },
  dayActionText: { fontSize: 21, color: colors.ink },

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
    gap: space.md,
    minHeight: 82,
    borderRadius: radius.md,
    backgroundColor: colors.card,
    padding: space.md,
    borderWidth: 1.5,
    borderColor: colors.border,
  },
  mealSource: { borderColor: colors.brand, backgroundColor: colors.brandSoft },
  mealTarget: { borderColor: colors.accent, borderStyle: 'dashed' },
  mealImage: {
    width: 68,
    height: 68,
    borderRadius: radius.sm,
    backgroundColor: colors.surfaceDeep,
  },
  mealBody: { flex: 1, gap: 3 },
  mealName: {
    fontFamily: fonts.display,
    fontSize: 18,
    lineHeight: 22,
    fontWeight: '700',
    color: colors.ink,
  },
  mealMeta: { fontSize: 12, color: colors.inkSoft },
  mealTail: { alignItems: 'flex-end', gap: space.xs },
  chevron: { fontSize: 22, color: colors.inkSoft, lineHeight: 24 },
  changeButton: {
    minHeight: 44,
    paddingHorizontal: space.md,
    borderRadius: radius.sm,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.field,
  },
  changeButtonText: { fontSize: 12, fontWeight: '800', color: colors.ink },

  weekButton: { marginTop: space.sm },
});

const recipeStyles = StyleSheet.create({
  overlay: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    zIndex: 25,
    backgroundColor: colors.surface,
  },
  scroller: { flex: 1 },
  scroll: { backgroundColor: colors.surface },
  hero: {
    position: 'relative',
    height: 410,
    backgroundColor: colors.surfaceDeep,
  },
  image: { width: '100%', height: '100%' },
  heroAction: {
    position: 'absolute',
    width: 48,
    height: 48,
    borderRadius: 24,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: RECIPE_HERO_ACTION_BACKGROUND,
    shadowColor: RECIPE_HERO_ACTION_SHADOW,
    shadowOpacity: 0.16,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 5 },
    elevation: 5,
  },
  backAction: { left: space.lg },
  backText: { marginTop: -3, fontSize: 34, lineHeight: 36, color: colors.card },
  body: {
    marginTop: -34,
    paddingTop: space.xxl,
    paddingHorizontal: 20,
    paddingBottom: space.xl,
    gap: space.xl,
    borderTopLeftRadius: 32,
    borderTopRightRadius: 32,
    backgroundColor: colors.surface,
  },
  topline: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  mealType: {
    fontSize: 11,
    fontWeight: '900',
    color: colors.brand,
    textTransform: 'uppercase',
    letterSpacing: 1.2,
  },
  suggestion: { fontSize: 10, color: colors.inkSoft },
  name: {
    fontFamily: fonts.display,
    fontSize: 32,
    lineHeight: 38,
    fontWeight: '600',
    color: colors.ink,
    letterSpacing: -0.9,
  },
  metadata: {
    minHeight: 72,
    flexDirection: 'row',
    alignItems: 'stretch',
    borderTopWidth: 1,
    borderBottomWidth: 1,
    borderColor: colors.border,
  },
  metadataCell: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 5,
  },
  metadataCellDivider: { borderLeftWidth: 1, borderLeftColor: colors.border },
  metadataLabel: {
    fontSize: 10,
    lineHeight: 13,
    color: colors.inkSoft,
    fontWeight: '800',
    letterSpacing: 1.25,
  },
  metadataValue: {
    fontFamily: fonts.display,
    fontSize: 18,
    lineHeight: 22,
    color: colors.ink,
    fontWeight: '600',
  },
  metadataValueCapitalized: { textTransform: 'capitalize' },
  authorRow: {
    minHeight: 52,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
  },
  authorAvatar: {
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.accentSoft,
  },
  authorInitial: {
    fontFamily: fonts.display,
    fontSize: 20,
    lineHeight: 24,
    fontWeight: '700',
    color: colors.accent,
  },
  authorCopy: { flex: 1, gap: 2 },
  authorLabel: {
    fontSize: 9,
    lineHeight: 12,
    fontWeight: '800',
    letterSpacing: 1.15,
    color: colors.inkSoft,
  },
  authorName: { fontSize: 14, lineHeight: 19, fontWeight: '700', color: colors.ink },
  missing: {
    gap: space.sm,
    padding: space.xl,
    borderRadius: radius.md,
    backgroundColor: colors.brandSoft,
  },
  missingTitle: { fontSize: 18, lineHeight: 23, fontWeight: '800', color: colors.ink },
  missingBody: { fontSize: 14, lineHeight: 21, color: colors.inkSoft },
  section: { gap: space.lg, marginTop: space.md },
  sectionHeading: {
    flexDirection: 'row',
    alignItems: 'baseline',
    justifyContent: 'space-between',
    gap: space.md,
  },
  sectionTitle: {
    fontFamily: fonts.display,
    fontSize: 23,
    lineHeight: 28,
    fontWeight: '600',
    color: colors.ink,
  },
  sectionCount: { fontSize: 12, lineHeight: 17, color: colors.inkSoft },
  ingredientList: {
    borderTopWidth: 1,
    borderTopColor: colors.border,
  },
  ingredientRow: {
    minHeight: 58,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    paddingVertical: space.md,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  ingredientBullet: {
    width: 7,
    height: 7,
    borderRadius: 4,
    backgroundColor: colors.olive,
  },
  ingredientText: { flex: 1, fontSize: 15, lineHeight: 21, color: colors.ink },
  step: {
    minHeight: 76,
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: space.lg,
    paddingBottom: space.lg,
  },
  stepBorder: { borderBottomWidth: 1, borderBottomColor: colors.border },
  stepNumber: {
    width: 30,
    fontFamily: fonts.display,
    fontSize: 26,
    lineHeight: 31,
    fontWeight: '700',
    color: colors.accent,
    textAlign: 'center',
  },
  stepText: { flex: 1, paddingTop: 3, fontSize: 15, lineHeight: 23, color: colors.ink },
  changeMeal: {
    minHeight: 44,
    alignSelf: 'flex-start',
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    paddingHorizontal: 2,
  },
  changeMealText: { fontSize: 14, lineHeight: 20, fontWeight: '700', color: colors.inkSoft },
  changeMealArrow: { fontSize: 23, lineHeight: 25, color: colors.inkSoft },
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
    backgroundColor: colors.scrim,
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

const STRIP_LABEL_STYLE = [styles.eyebrow, plan.stripLabel];
const WEEK_BUTTON_STYLE = [styles.secondaryButton, plan.weekButton];
const METADATA_VALUE_CAPITALIZED_STYLE = [
  recipeStyles.metadataValue,
  recipeStyles.metadataValueCapitalized,
];
const METADATA_CELL_DIVIDER_STYLE = [recipeStyles.metadataCell, recipeStyles.metadataCellDivider];
const GHOST_GRID_BUTTON_STYLE = [styles.ghostButton, sheetStyles.gridButton];
const GHOST_GRID_BUTTON_TEXT_STYLE = [styles.ghostButtonText, sheetStyles.gridButtonText];
const GHOST_FLEX_BUTTON_STYLE = [styles.ghostButton, sheetStyles.flexButton];
const PRIMARY_FLEX_BUTTON_STYLE = [styles.primaryButton, sheetStyles.flexButton];
const SERVINGS_INPUT_STYLE = [styles.input, sheetStyles.servingsInput];
