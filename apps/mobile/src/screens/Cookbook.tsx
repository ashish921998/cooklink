import { useCallback, useEffect, useMemo, useState } from 'react';
import { Image, StyleSheet, View } from 'react-native';
import type { TextStyle } from 'react-native';
import { useApi } from '../lib/api';
import type { HouseholdSummary, PlannedMeal } from '../lib/households';
import { mealImage } from '../lib/meal-images';
import {
  FadeSlideIn,
  ErrorNote,
  Loading,
  PressableScale,
  TabScrollView,
  colors,
  fonts,
  radius,
  space,
} from '../components/design-system';
import { Text, TextInput } from '../components/Typography';

type BookFilter = 'all' | 'with-recipe' | 'to-cook' | 'baking';

const BOOK_FILTERS: ReadonlyArray<{ value: BookFilter; label: string }> = [
  { value: 'all', label: 'All Recipes' },
  { value: 'with-recipe', label: 'With Recipe' },
  { value: 'to-cook', label: 'To Cook' },
  { value: 'baking', label: 'Baking' },
];

const selectedAccessibilityState = { selected: true };
const unselectedAccessibilityState = { selected: false };
const overflowBackdrop = 'rgba(83, 75, 65, 0.64)';
const white = '#FFFFFF';

function recipeStatus(meal: PlannedMeal) {
  if (meal.isSpecial) return 'Special meal';
  if (meal.recipeId) return 'Recipe available';
  return 'Planned meal';
}

export function CookbookScreen({
  household,
  onOpenMeal,
  onOpenGroceries,
  onBrowseRecipes,
  savedMealIds,
  onToggleSaved,
}: {
  household: HouseholdSummary;
  onOpenMeal: (meal: PlannedMeal) => void;
  onOpenGroceries: () => void;
  onBrowseRecipes: () => void;
  savedMealIds: ReadonlySet<string>;
  onToggleSaved: (mealId: string) => void;
}) {
  const api = useApi();
  const [meals, setMeals] = useState<PlannedMeal[] | null>(null);
  const [filter, setFilter] = useState<BookFilter>('all');
  const [query, setQuery] = useState('');
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  const retry = useCallback(() => setAttempt((value) => value + 1), []);
  const clearQuery = useCallback(() => setQuery(''), []);
  const toggleEditing = useCallback(() => setEditing((value) => !value), []);
  const filterPressHandlers = useMemo<Record<BookFilter, () => void>>(
    () => ({
      all: () => setFilter('all'),
      'with-recipe': () => setFilter('with-recipe'),
      'to-cook': () => setFilter('to-cook'),
      baking: () => setFilter('baking'),
    }),
    [],
  );

  useEffect(() => {
    setMeals(null);
    setError(null);
    api<{ meals: PlannedMeal[] }>(`/v1/households/${household.id}/meal-plan`)
      .then((data) => setMeals(data.meals))
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : 'Could not load saved recipes.');
        setMeals([]);
      });
  }, [api, attempt, household.id]);

  const entries = useMemo(() => {
    if (!meals) return [];

    const savedMeals = meals.filter((meal) => savedMealIds.has(meal.id));
    let filtered = savedMeals;
    if (filter === 'with-recipe') filtered = savedMeals.filter((meal) => meal.recipeId);
    if (filter === 'to-cook') filtered = savedMeals.filter((meal) => !meal.recipeId);
    if (filter === 'baking') {
      filtered = savedMeals.filter((meal) =>
        /\b(cake|bread|cookie|biscuit|pie|tart|bake)\b/i.test(meal.name),
      );
    }

    const normalized = query.trim().toLowerCase();
    if (normalized) {
      filtered = filtered.filter(
        (meal) =>
          meal.name.toLowerCase().includes(normalized) || meal.mealType.includes(normalized),
      );
    }

    return filtered;
  }, [filter, meals, query, savedMealIds]);

  const entryActions = useMemo(
    () =>
      new Map(
        entries.map((meal) => [
          meal.id,
          {
            open: () => (editing ? onToggleSaved(meal.id) : onOpenMeal(meal)),
            edit: () => (editing ? onToggleSaved(meal.id) : setEditing(true)),
          },
        ]),
      ),
    [editing, entries, onOpenMeal, onToggleSaved],
  );

  if (!meals) return <Loading label="Opening saved recipes" />;
  const savedCount = meals.filter((meal) => savedMealIds.has(meal.id)).length;

  return (
    <TabScrollView contentContainerStyle={book.scroll} showsVerticalScrollIndicator={false}>
      <View style={book.topbar}>
        <Text style={book.title}>Saved Recipes</Text>
        <PressableScale
          accessibilityRole="button"
          accessibilityLabel="Browse meals to save"
          style={book.addButton}
          onPress={onBrowseRecipes}
        >
          <Text style={book.add}>＋</Text>
        </PressableScale>
      </View>

      {error ? (
        <View style={book.errorBlock}>
          <ErrorNote>{error}</ErrorNote>
          <PressableScale
            accessibilityRole="button"
            accessibilityLabel="Retry saved recipes"
            style={book.retryButton}
            onPress={retry}
          >
            <Text style={book.retryText}>Retry</Text>
          </PressableScale>
        </View>
      ) : null}

      <View style={book.searchBox}>
        <Text style={book.searchIcon}>⌕</Text>
        <TextInput
          accessibilityLabel="Search your saved recipe collection"
          value={query}
          onChangeText={setQuery}
          placeholder="Search your collection…"
          placeholderTextColor={colors.inkSoft}
          returnKeyType="search"
          style={book.searchInput}
        />
        {query ? (
          <PressableScale
            accessibilityRole="button"
            accessibilityLabel="Clear saved recipe search"
            style={book.clearButton}
            onPress={clearQuery}
          >
            <Text style={book.clearText}>×</Text>
          </PressableScale>
        ) : null}
      </View>

      <View style={book.tabs}>
        {BOOK_FILTERS.map((option) => {
          const selected = filter === option.value;
          return (
            <PressableScale
              key={option.value}
              accessibilityRole="button"
              accessibilityState={
                selected ? selectedAccessibilityState : unselectedAccessibilityState
              }
              accessibilityLabel={`Show ${option.label}`}
              style={book.tab}
              onPress={filterPressHandlers[option.value]}
            >
              <Text style={selected ? selectedTabTextStyle : book.tabText}>{option.label}</Text>
              {selected ? <View style={book.tabUnderline} /> : null}
            </PressableScale>
          );
        })}
      </View>

      <View style={book.collectionHeader}>
        <Text style={book.savedCount}>{savedCount} recipes saved</Text>
        <PressableScale
          accessibilityRole="button"
          accessibilityLabel={editing ? 'Finish editing saved recipes' : 'Edit saved recipes'}
          style={book.editButton}
          onPress={toggleEditing}
        >
          <Text style={book.edit}>{editing ? 'Done' : 'Edit'}</Text>
        </PressableScale>
      </View>

      <View style={book.entries}>
        {entries.length ? (
          entries.map((meal, index) => {
            const actions = entryActions.get(meal.id)!;
            return (
              <FadeSlideIn key={meal.id} delay={index * 40}>
                <View style={book.entry}>
                  <PressableScale
                    accessibilityRole="button"
                    accessibilityLabel={
                      editing
                        ? `Remove ${meal.name} from saved recipes`
                        : `Open saved recipe ${meal.name}`
                    }
                    style={book.entryMain}
                    onPress={actions.open}
                  >
                    <Image
                      accessible={false}
                      source={mealImage(meal.name, meal.mealType).source}
                      style={book.entryImage}
                      resizeMode="cover"
                    />
                    <Text numberOfLines={2} style={book.entryName}>
                      {meal.name}
                    </Text>
                    <View style={book.entryMeta}>
                      <Text style={book.metaText}>{meal.servings} servings</Text>
                      <Text style={book.metaDot}>·</Text>
                      <Text style={book.metaText}>{recipeStatus(meal)}</Text>
                    </View>
                  </PressableScale>
                  <PressableScale
                    accessibilityRole="button"
                    accessibilityLabel={
                      editing
                        ? `Remove ${meal.name} from saved recipes`
                        : `Edit saved recipe ${meal.name}`
                    }
                    style={book.overflowButton}
                    onPress={actions.edit}
                  >
                    <Text style={book.overflowText}>{editing ? '×' : '⋮'}</Text>
                  </PressableScale>
                </View>
              </FadeSlideIn>
            );
          })
        ) : (
          <View style={book.emptyState}>
            <Text style={book.emptyTitle}>No saved recipes found</Text>
            <Text style={book.emptyBody}>Try another collection or search.</Text>
          </View>
        )}
      </View>

      <PressableScale
        accessibilityRole="button"
        accessibilityLabel="Open shopping list"
        style={book.shopping}
        onPress={onOpenGroceries}
      >
        <View style={book.shoppingIconWrap}>
          <Text style={book.shoppingIcon}>▤</Text>
        </View>
        <View style={book.shoppingCopy}>
          <Text style={book.shoppingTitle}>Shopping List</Text>
          <Text style={book.shoppingBody}>Ingredients from your planned recipes</Text>
        </View>
        <Text style={book.shoppingArrow}>→</Text>
      </PressableScale>
    </TabScrollView>
  );
}

const book = StyleSheet.create({
  scroll: {
    paddingHorizontal: 20,
    paddingTop: 58,
    paddingBottom: 36,
    backgroundColor: colors.surface,
  },
  topbar: {
    minHeight: 44,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: space.lg,
  },
  errorBlock: { gap: space.sm, marginBottom: space.md },
  retryButton: {
    minHeight: 44,
    alignSelf: 'flex-start',
    paddingHorizontal: space.lg,
    borderRadius: radius.sm,
    backgroundColor: colors.field,
    justifyContent: 'center',
  },
  retryText: { color: colors.accent, fontSize: 13, fontWeight: '700' },
  title: {
    flex: 1,
    fontFamily: fonts.display,
    fontSize: 32,
    lineHeight: 37,
    color: colors.ink,
    fontWeight: '600',
  },
  addButton: {
    width: 44,
    height: 44,
    borderRadius: radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.field,
  },
  add: { fontSize: 23, lineHeight: 25, color: colors.inkSoft },
  searchBox: {
    minHeight: 50,
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: radius.md,
    paddingLeft: space.md,
    backgroundColor: colors.field,
  },
  searchIcon: { fontSize: 21, color: colors.inkSoft, marginRight: space.sm },
  searchInput: { flex: 1, minHeight: 50, fontSize: 14, color: colors.ink, paddingVertical: 0 },
  clearButton: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  clearText: { fontSize: 20, color: colors.inkSoft },
  tabs: {
    minHeight: 52,
    flexDirection: 'row',
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
    marginTop: space.sm,
  },
  tab: {
    flex: 1,
    minHeight: 52,
    alignItems: 'center',
    justifyContent: 'center',
    position: 'relative',
  },
  tabText: { fontSize: 10, color: colors.inkSoft, fontWeight: '500' },
  tabTextOn: { color: colors.ink, fontWeight: '700' },
  tabUnderline: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: -1,
    height: 2,
    backgroundColor: colors.accent,
  },
  collectionHeader: {
    minHeight: 68,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  savedCount: { fontSize: 12, color: colors.inkSoft },
  editButton: { minHeight: 44, paddingLeft: space.lg, justifyContent: 'center' },
  edit: { fontSize: 12, color: colors.accent, fontWeight: '700' },
  entries: { gap: space.xl },
  entry: { minHeight: 248, position: 'relative' },
  entryMain: { minHeight: 248 },
  entryImage: {
    width: '100%',
    height: 184,
    borderRadius: radius.xl,
    backgroundColor: colors.surfaceDeep,
  },
  overflowButton: {
    position: 'absolute',
    top: space.md,
    right: space.md,
    width: 44,
    height: 44,
    borderRadius: radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: overflowBackdrop,
  },
  overflowText: { color: white, fontSize: 22, lineHeight: 23 },
  entryName: {
    fontFamily: fonts.display,
    fontSize: 19,
    lineHeight: 24,
    color: colors.ink,
    fontWeight: '600',
    marginTop: space.md,
  },
  entryMeta: { flexDirection: 'row', alignItems: 'center', gap: 7, marginTop: 5 },
  metaText: { color: colors.inkSoft, fontSize: 11 },
  metaDot: { color: colors.inkSoft, fontSize: 12 },
  emptyState: {
    minHeight: 180,
    alignItems: 'center',
    justifyContent: 'center',
    borderTopWidth: 1,
    borderBottomWidth: 1,
    borderColor: colors.border,
  },
  emptyTitle: { fontFamily: fonts.display, fontSize: 19, color: colors.ink, fontWeight: '700' },
  emptyBody: { fontSize: 13, color: colors.inkSoft, marginTop: space.xs },
  shopping: {
    minHeight: 72,
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: space.xl,
    paddingHorizontal: space.md,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    backgroundColor: colors.field,
  },
  shoppingIconWrap: {
    width: 44,
    height: 44,
    borderRadius: radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.card,
  },
  shoppingIcon: { color: colors.brand, fontSize: 21 },
  shoppingCopy: { flex: 1, marginHorizontal: space.md },
  shoppingTitle: {
    fontFamily: fonts.display,
    fontSize: 17,
    lineHeight: 21,
    color: colors.ink,
    fontWeight: '700',
  },
  shoppingBody: { color: colors.inkSoft, fontSize: 11, marginTop: 2 },
  shoppingArrow: { color: colors.accent, fontSize: 22 },
});

const selectedTabTextStyle = StyleSheet.compose<TextStyle, TextStyle, TextStyle>(
  book.tabText,
  book.tabTextOn,
);
