import { memo, useCallback, useEffect, useMemo, useState } from 'react';
import { Image, ScrollView, StyleSheet, View } from 'react-native';
import { useApi } from '../lib/api';
import type { HouseholdSummary, PlannedMeal } from '../lib/households';
import { mealImage } from '../lib/meal-images';
import {
  ErrorNote,
  Loading,
  PressableScale,
  TabScrollView,
  colors,
  fonts,
  radius,
  space,
} from '../components/ui';
import { Text, TextInput } from '../components/Typography';

type SearchFilter = 'all' | PlannedMeal['mealType'];

const FILTERS: ReadonlyArray<{ value: SearchFilter; label: string }> = [
  { value: 'all', label: 'Filters' },
  { value: 'breakfast', label: 'Breakfast' },
  { value: 'lunch', label: 'Lunch' },
  { value: 'dinner', label: 'Dinner' },
];

const INITIAL_RESULT_COUNT = 6;
const RESULT_BATCH_SIZE = 5;
const SELECTED_ACCESSIBILITY_STATE = { selected: true } as const;
const UNSELECTED_ACCESSIBILITY_STATE = { selected: false } as const;

function matchesFilter(meal: PlannedMeal, filter: SearchFilter) {
  return filter === 'all' || meal.mealType === filter;
}

function relevanceScore(meal: PlannedMeal, query: string) {
  const name = meal.name.toLowerCase();
  if (name === query) return 0;
  if (name.startsWith(query)) return 1;
  if (name.includes(query)) return 2;
  if (meal.mealType.startsWith(query)) return 3;
  return 4;
}

export function ArchiveScreen({
  household,
  onOpenMeal,
  onOpenPlan,
}: {
  household: HouseholdSummary;
  onOpenMeal: (meal: PlannedMeal) => void;
  onOpenPlan: () => void;
}) {
  const api = useApi();
  const [meals, setMeals] = useState<PlannedMeal[] | null>(null);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<SearchFilter>('all');
  const [sort, setSort] = useState<'relevance' | 'alphabetical'>('relevance');
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [renderedCount, setRenderedCount] = useState(INITIAL_RESULT_COUNT);
  const retry = useCallback(() => setAttempt((value) => value + 1), []);
  const clearQuery = useCallback(() => setQuery(''), []);
  const toggleSort = useCallback(
    () => setSort((value) => (value === 'relevance' ? 'alphabetical' : 'relevance')),
    [],
  );

  useEffect(() => {
    setMeals(null);
    setError(null);
    api<{ meals: PlannedMeal[] }>(`/v1/households/${household.id}/meal-plan`)
      .then((data) => setMeals(data.meals))
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : 'Could not search planned meals.');
        setMeals([]);
      });
  }, [api, attempt, household.id]);

  const filtered = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    return (meals ?? []).filter((meal) => {
      const queryMatches =
        !normalized ||
        meal.name.toLowerCase().includes(normalized) ||
        meal.mealType.includes(normalized);
      return queryMatches && matchesFilter(meal, filter);
    });
  }, [filter, meals, query]);

  const sorted = useMemo(() => {
    if (sort === 'alphabetical') {
      return [...filtered].sort((a, b) => a.name.localeCompare(b.name));
    }
    const normalized = query.trim().toLowerCase();
    return normalized
      ? [...filtered].sort((a, b) => relevanceScore(a, normalized) - relevanceScore(b, normalized))
      : filtered;
  }, [filtered, query, sort]);

  // The weekly plan is bounded at 21 rows. Mount the visible rows with the tab
  // transition, then fill the off-screen remainder in small idle batches. This
  // avoids both the 21-row mount spike and VirtualizedList's larger startup
  // overhead for such a small collection.
  useEffect(() => {
    setRenderedCount(INITIAL_RESULT_COUNT);
    if (sorted.length <= INITIAL_RESULT_COUNT) return;

    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const scheduleBatch = () => {
      timer = setTimeout(() => {
        if (cancelled) return;
        setRenderedCount((current) => {
          const next = Math.min(current + RESULT_BATCH_SIZE, sorted.length);
          if (next < sorted.length) scheduleBatch();
          return next;
        });
      }, 80);
    };
    const idleTask = requestIdleCallback(scheduleBatch);

    return () => {
      cancelled = true;
      cancelIdleCallback(idleTask);
      if (timer) clearTimeout(timer);
    };
  }, [sorted.length]);

  if (!meals) return <Loading label="Opening search" />;

  const trending = Array.from(new Set(meals.map((meal) => meal.name))).slice(0, 4);
  const visibleMeals = sorted.slice(0, renderedCount);

  return (
    <TabScrollView contentContainerStyle={archive.scroll} showsVerticalScrollIndicator={false}>
      <Text style={archive.title}>Search</Text>

      {error ? (
        <View style={archive.errorBlock}>
          <ErrorNote>{error}</ErrorNote>
          <PressableScale
            accessibilityRole="button"
            accessibilityLabel="Retry planned meal search"
            style={archive.retryButton}
            onPress={retry}
          >
            <Text style={archive.retryText}>Retry</Text>
          </PressableScale>
        </View>
      ) : null}

      <View style={archive.searchBox}>
        <Text style={archive.searchIcon}>⌕</Text>
        <TextInput
          accessibilityLabel="Search planned meals by name or meal type"
          value={query}
          onChangeText={setQuery}
          placeholder="Search your planned meals…"
          placeholderTextColor={colors.inkSoft}
          returnKeyType="search"
          style={archive.searchInput}
        />
        {query ? (
          <PressableScale
            accessibilityRole="button"
            accessibilityLabel="Clear recipe search"
            style={archive.clearButton}
            onPress={clearQuery}
          >
            <Text style={archive.clearText}>×</Text>
          </PressableScale>
        ) : null}
      </View>

      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={archive.filters}
      >
        {FILTERS.map((option) => (
          <FilterChip
            key={option.value}
            option={option}
            selected={filter === option.value}
            onSelect={setFilter}
          />
        ))}
      </ScrollView>

      <View style={archive.trendingSection}>
        <Text style={archive.eyebrow}>FROM YOUR PLAN</Text>
        <View style={archive.trendingTags}>
          {trending.map((trend) => (
            <TrendingTag key={trend} trend={trend} onSelect={setQuery} />
          ))}
        </View>
      </View>

      <View style={archive.resultHeader}>
        <Text style={archive.resultCount}>{sorted.length} results found</Text>
        <PressableScale
          accessibilityRole="button"
          accessibilityLabel={
            sort === 'relevance' ? 'Sort planned meals alphabetically' : 'Use plan order'
          }
          style={archive.sortButton}
          onPress={toggleSort}
        >
          <Text style={archive.sortText}>{sort === 'relevance' ? 'Relevance⌄' : 'A–Z⌄'}</Text>
        </PressableScale>
      </View>

      <View>
        {visibleMeals.length ? (
          visibleMeals.map((meal) => (
            <ArchiveResultRow key={meal.id} meal={meal} onOpenMeal={onOpenMeal} />
          ))
        ) : (
          <View style={archive.emptyState}>
            <Text style={archive.emptyTitle}>No planned meals found</Text>
            <Text style={archive.emptyBody}>Try another search or filter.</Text>
          </View>
        )}
      </View>

      <PressableScale
        accessibilityRole="button"
        accessibilityLabel="Open full meal plan"
        style={archive.openPlan}
        onPress={onOpenPlan}
      >
        <Text style={archive.openPlanText}>Open full meal plan →</Text>
      </PressableScale>
    </TabScrollView>
  );
}

function FilterChip({
  option,
  selected,
  onSelect,
}: {
  option: (typeof FILTERS)[number];
  selected: boolean;
  onSelect: (filter: SearchFilter) => void;
}) {
  const selectFilter = useCallback(() => onSelect(option.value), [onSelect, option.value]);

  return (
    <PressableScale
      accessibilityRole="button"
      accessibilityState={selected ? SELECTED_ACCESSIBILITY_STATE : UNSELECTED_ACCESSIBILITY_STATE}
      accessibilityLabel={`Filter planned meals by ${option.label}`}
      style={selected ? FILTER_CHIP_ACTIVE_STYLE : archive.filterChip}
      onPress={selectFilter}
    >
      {option.value === 'all' ? (
        <Text style={selected ? SLIDERS_ACTIVE_STYLE : archive.sliders}>≋</Text>
      ) : null}
      <Text style={selected ? FILTER_TEXT_ACTIVE_STYLE : archive.filterText}>{option.label}</Text>
    </PressableScale>
  );
}

function TrendingTag({ trend, onSelect }: { trend: string; onSelect: (query: string) => void }) {
  const selectTrend = useCallback(() => onSelect(trend), [onSelect, trend]);

  return (
    <PressableScale
      accessibilityRole="button"
      accessibilityLabel={`Search for ${trend}`}
      style={archive.trendingTag}
      onPress={selectTrend}
    >
      <Text style={archive.trendingText}>{trend}</Text>
    </PressableScale>
  );
}

const ArchiveResultRow = memo(function ArchiveResultRow({
  meal,
  onOpenMeal,
}: {
  meal: PlannedMeal;
  onOpenMeal: (meal: PlannedMeal) => void;
}) {
  const onPress = useCallback(() => onOpenMeal(meal), [meal, onOpenMeal]);
  return (
    <PressableScale
      accessibilityRole="button"
      accessibilityLabel={
        meal.recipeId ? `View recipe for ${meal.name}` : `Open planned meal ${meal.name}`
      }
      style={archive.resultRow}
      onPress={onPress}
    >
      <Image
        accessible={false}
        source={mealImage(meal.name, meal.mealType).source}
        style={archive.resultImage}
      />
      <View style={archive.resultBody}>
        <Text numberOfLines={2} style={archive.resultName}>
          {meal.name}
        </Text>
        <View style={archive.metaRow}>
          <Text style={archive.metaText}>{meal.servings} servings</Text>
          <Text style={archive.metaDot}>·</Text>
          <Text style={archive.metaText}>{meal.mealType}</Text>
        </View>
        <Text style={archive.viewRecipe}>{meal.recipeId ? 'View Recipe →' : 'Open Meal →'}</Text>
      </View>
    </PressableScale>
  );
});

const archive = StyleSheet.create({
  scroll: {
    paddingHorizontal: 20,
    paddingTop: 58,
    paddingBottom: 36,
    backgroundColor: colors.surface,
  },
  title: {
    fontFamily: fonts.display,
    fontSize: 32,
    lineHeight: 37,
    fontWeight: '600',
    color: colors.ink,
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
  filters: { gap: space.sm, paddingTop: space.md, paddingBottom: space.lg },
  filterChip: {
    minHeight: 44,
    paddingHorizontal: space.md,
    borderRadius: radius.md,
    backgroundColor: colors.field,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
  },
  filterChipOn: { backgroundColor: colors.olive },
  sliders: { color: colors.inkSoft, fontSize: 16, fontWeight: '800' },
  filterText: { color: colors.ink, fontSize: 12, fontWeight: '600' },
  filterTextOn: { color: colors.card },
  trendingSection: { marginBottom: space.xl },
  eyebrow: {
    fontSize: 10,
    lineHeight: 15,
    color: colors.inkSoft,
    letterSpacing: 1.7,
    fontWeight: '600',
    marginBottom: space.sm,
  },
  trendingTags: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm },
  trendingTag: {
    minHeight: 44,
    paddingHorizontal: space.md,
    borderRadius: radius.sm,
    justifyContent: 'center',
    backgroundColor: colors.field,
  },
  trendingText: { color: colors.ink, fontSize: 12, fontWeight: '500' },
  resultHeader: {
    minHeight: 44,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: space.sm,
  },
  resultCount: { fontSize: 12, color: colors.inkSoft },
  sortButton: { minHeight: 44, paddingLeft: space.md, justifyContent: 'center' },
  sortText: { fontSize: 12, color: colors.accent, fontWeight: '700' },
  resultRow: {
    minHeight: 128,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    paddingVertical: space.md,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  resultImage: {
    width: 104,
    height: 104,
    borderRadius: radius.lg,
    backgroundColor: colors.surfaceDeep,
  },
  resultBody: { flex: 1, alignSelf: 'stretch', justifyContent: 'center', gap: 6 },
  resultName: {
    fontFamily: fonts.display,
    fontSize: 18,
    lineHeight: 22,
    color: colors.ink,
    fontWeight: '600',
  },
  metaRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  metaText: { fontSize: 11, color: colors.inkSoft },
  metaDot: { fontSize: 12, color: colors.inkSoft },
  viewRecipe: { fontSize: 11, color: colors.accent, fontWeight: '700' },
  emptyState: {
    minHeight: 150,
    alignItems: 'center',
    justifyContent: 'center',
    borderTopWidth: 1,
    borderBottomWidth: 1,
    borderColor: colors.border,
  },
  emptyTitle: { fontFamily: fonts.display, fontSize: 19, color: colors.ink, fontWeight: '700' },
  emptyBody: { fontSize: 13, color: colors.inkSoft, marginTop: space.xs },
  openPlan: {
    minHeight: 44,
    alignSelf: 'flex-start',
    marginTop: space.lg,
    justifyContent: 'center',
  },
  openPlanText: { color: colors.accent, fontSize: 13, fontWeight: '700' },
});

const FILTER_CHIP_ACTIVE_STYLE = [archive.filterChip, archive.filterChipOn];
const SLIDERS_ACTIVE_STYLE = [archive.sliders, archive.filterTextOn];
const FILTER_TEXT_ACTIVE_STYLE = [archive.filterText, archive.filterTextOn];
