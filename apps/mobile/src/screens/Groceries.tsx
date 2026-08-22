import { useCallback, useEffect, useMemo, useState } from 'react';
import { RefreshControl, StyleSheet, View } from 'react-native';
import type { HouseholdSummary } from '../lib/households';
import {
  useGroceryRequests,
  type GroceryRequestItem,
  type GroceryResolution,
} from '../lib/grocery';
import { useApi } from '../lib/api';
import {
  Chip,
  ErrorNote,
  FadeSlideIn,
  PotLoader,
  PressableScale,
  TabScrollView,
  colors,
  fonts,
  radius,
  shadow,
  space,
  styles,
} from '../components/design-system';
import { Text } from '../components/Typography';
import { InstamartOrderFlow } from '../components/InstamartOrderFlow';

type NeedDay = 'today' | 'tomorrow' | 'day_after';
type CartItem = {
  id: string;
  ingredientKey: string | null;
  groceryRequestId: string | null;
  freeTextItem: string | null;
  needDay: NeedDay;
  affectedMeals: { date: string; mealType: string; name: string }[];
  confidence: 'likely_available' | 'may_be_low' | 'unknown';
  memberState: 'pending' | 'kept' | 'removed';
  removalReason: 'already_have' | 'not_needed' | 'buy_later' | null;
  checkAtHome: boolean;
};

const DAY_LABEL: Record<NeedDay, string> = {
  today: 'Today',
  tomorrow: 'Tomorrow',
  day_after: 'Day after tomorrow',
};

const CHECKED_ACCESSIBILITY_STATE = { checked: true } as const;
const UNCHECKED_ACCESSIBILITY_STATE = { checked: false } as const;

/**
 * Member grocery review: Cook requests first, then the three-day suggested
 * cart grouped by need date. This is deliberately an approval surface, not an
 * inventory spreadsheet; pantry uncertainty stays visible and correctable.
 */
export function GroceriesScreen({ household }: { household: HouseholdSummary }) {
  const api = useApi();
  const { list: listRequests, resolve: resolveGroceryRequest } = useGroceryRequests(household.id);
  const isCook = household.role === 'cook';
  const [requests, setRequests] = useState<GroceryRequestItem[] | null>(null);
  const [cart, setCart] = useState<CartItem[] | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const [pending, suggested] = await Promise.all([
        listRequests('pending'),
        api<{ items: CartItem[] }>(`/v1/households/${household.id}/suggested-cart`),
      ]);
      setRequests(pending);
      setCart(suggested.items);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load groceries.');
      setRequests((current) => current ?? []);
      setCart((current) => current ?? []);
    }
  }, [api, household.id, listRequests]);

  useEffect(() => {
    void load();
  }, [load]);

  const refresh = useCallback(async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  }, [load]);

  const resolveRequest = useCallback(
    async (request: GroceryRequestItem, resolution: GroceryResolution) => {
      setBusyId(request.id);
      setError(null);
      try {
        await resolveGroceryRequest(request.id, request.version, resolution);
        await load();
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Could not update the request.');
      } finally {
        setBusyId(null);
      }
    },
    [load, resolveGroceryRequest],
  );

  const setCartState = useCallback(
    async (item: CartItem, state: 'kept' | 'removed') => {
      setBusyId(item.id);
      setError(null);
      try {
        const data = await api<{ item: CartItem }>(
          `/v1/households/${household.id}/suggested-cart/${item.id}`,
          {
            method: 'PATCH',
            body: JSON.stringify({
              state,
              removalReason: state === 'removed' ? 'already_have' : null,
            }),
          },
        );
        setCart((current) => (current ?? []).map((row) => (row.id === item.id ? data.item : row)));
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Could not update the cart.');
      } finally {
        setBusyId(null);
      }
    },
    [api, household.id],
  );

  const refreshControl = useMemo(
    () => <RefreshControl refreshing={refreshing} onRefresh={refresh} />,
    [refresh, refreshing],
  );

  const activeCart = useMemo(
    () => (cart ?? []).filter((item) => item.memberState !== 'removed'),
    [cart],
  );

  if (requests === null || cart === null) return <PotLoader label="Preparing groceries" />;

  return (
    <View style={grocery.root}>
      <TabScrollView
        contentContainerStyle={grocery.scroll}
        showsVerticalScrollIndicator={false}
        refreshControl={refreshControl}
      >
        <FadeSlideIn>
          <View style={grocery.head}>
            <Text style={styles.eyebrow}>
              {isCook ? 'Kitchen requests' : 'Three-day grocery plan'}
            </Text>
            <Text style={grocery.title}>
              {isCook ? 'Tell the household what ran out' : 'Review first. Order second.'}
            </Text>
            <Text style={grocery.subtitle}>
              {isCook
                ? 'You can follow requests here. A household member approves every purchase.'
                : 'Cook requests and meal-plan needs stay separate until you approve them.'}
            </Text>
          </View>
        </FadeSlideIn>

        {error ? <ErrorNote>{error}</ErrorNote> : null}

        <SectionHeading
          eyebrow="Requests"
          title={requests.length > 0 ? `${requests.length} need review` : 'Nothing waiting'}
        />
        {requests.length === 0 ? (
          <EmptyCard glyph="✓" body="New requests from your cook will appear here." />
        ) : (
          requests.map((request, index) => (
            <FadeSlideIn key={request.id} delay={index * 45}>
              <RequestCard
                request={request}
                isCook={isCook}
                busy={busyId === request.id}
                onResolve={resolveRequest}
              />
            </FadeSlideIn>
          ))
        )}

        <SectionHeading
          eyebrow="Suggested cart"
          title={`${activeCart.length} ${activeCart.length === 1 ? 'item' : 'items'} for the next 3 days`}
        />
        {activeCart.length === 0 ? (
          <EmptyCard glyph="⌁" body="Your reviewed meal-plan needs will appear here." />
        ) : (
          (Object.keys(DAY_LABEL) as NeedDay[]).map((day) => {
            const rows = activeCart.filter((item) => item.needDay === day);
            if (rows.length === 0) return null;
            return (
              <View key={day} style={grocery.dayGroup}>
                <Text style={grocery.dayLabel}>{DAY_LABEL[day]}</Text>
                <View style={grocery.cartCard}>
                  {rows.map((item, index) => (
                    <CartRow
                      key={item.id}
                      item={item}
                      showBorder={index > 0}
                      isCook={isCook}
                      busy={busyId === item.id}
                      onSetState={setCartState}
                    />
                  ))}
                </View>
              </View>
            );
          })
        )}

        {!isCook ? <InstamartOrderFlow householdId={household.id} /> : null}
      </TabScrollView>
    </View>
  );
}

function RequestCard({
  request,
  isCook,
  busy,
  onResolve,
}: {
  request: GroceryRequestItem;
  isCook: boolean;
  busy: boolean;
  onResolve: (request: GroceryRequestItem, resolution: GroceryResolution) => Promise<void>;
}) {
  const reject = useCallback(() => void onResolve(request, 'reject'), [onResolve, request]);
  const approve = useCallback(() => void onResolve(request, 'approve'), [onResolve, request]);

  return (
    <View style={grocery.requestCard}>
      <View style={grocery.sourceIcon}>
        <Text style={grocery.sourceIconText}>C</Text>
      </View>
      <View style={grocery.requestBody}>
        <Text style={grocery.itemName}>{request.itemText}</Text>
        <Text style={grocery.meta}>{request.quantityText || 'Quantity not specified'}</Text>
        <Text style={grocery.source}>Requested by the cook</Text>
      </View>
      {!isCook ? (
        <View style={grocery.requestActions}>
          <PressableScale
            accessibilityRole="button"
            accessibilityLabel={`Skip ${request.itemText}`}
            disabled={busy}
            style={grocery.iconButton}
            onPress={reject}
          >
            <Text style={grocery.iconButtonText}>×</Text>
          </PressableScale>
          <PressableScale
            accessibilityRole="button"
            accessibilityLabel={`Approve ${request.itemText}`}
            disabled={busy}
            style={APPROVE_BUTTON_STYLE}
            onPress={approve}
          >
            <Text style={grocery.approveText}>✓</Text>
          </PressableScale>
        </View>
      ) : (
        <Chip label="Pending" tint={colors.brandSoft} ink={colors.brand} />
      )}
    </View>
  );
}

function CartRow({
  item,
  showBorder,
  isCook,
  busy,
  onSetState,
}: {
  item: CartItem;
  showBorder: boolean;
  isCook: boolean;
  busy: boolean;
  onSetState: (item: CartItem, state: 'kept' | 'removed') => Promise<void>;
}) {
  const kept = item.memberState === 'kept';
  const name = displayIngredient(item);
  const source = item.groceryRequestId ? 'Cook request' : mealSource(item);
  const toggleState = useCallback(
    () => void onSetState(item, kept ? 'removed' : 'kept'),
    [item, kept, onSetState],
  );

  const checkStyle = kept
    ? isCook
      ? CHECKED_DISABLED_STYLE
      : CHECKED_STYLE
    : isCook
      ? DISABLED_CHECK_STYLE
      : grocery.check;

  return (
    <View style={showBorder ? CART_ROW_BORDER_STYLE : grocery.cartRow}>
      <PressableScale
        accessibilityRole="checkbox"
        accessibilityLabel={`${name}, ${source}`}
        accessibilityState={kept ? CHECKED_ACCESSIBILITY_STATE : UNCHECKED_ACCESSIBILITY_STATE}
        disabled={isCook || busy}
        style={checkStyle}
        onPress={toggleState}
      >
        <Text style={grocery.checkText}>{kept ? '✓' : ''}</Text>
      </PressableScale>
      <View style={grocery.cartBody}>
        <View style={grocery.itemLine}>
          <Text style={grocery.itemName}>{name}</Text>
          {item.checkAtHome ? <Chip label="Check at home" tint="#FFF0CF" ink="#7A4A00" /> : null}
        </View>
        <Text style={grocery.meta}>{source}</Text>
      </View>
    </View>
  );
}

function displayIngredient(item: CartItem): string {
  const value = item.freeTextItem ?? item.ingredientKey ?? 'Unspecified item';
  return value.replaceAll('_', ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function mealSource(item: CartItem): string {
  if (item.affectedMeals.length === 0) return 'Meal plan';
  const names = [...new Set(item.affectedMeals.map((meal) => meal.name))];
  return `For ${names.slice(0, 2).join(' and ')}${names.length > 2 ? ` +${names.length - 2}` : ''}`;
}

function SectionHeading({ eyebrow, title }: { eyebrow: string; title: string }) {
  return (
    <View style={grocery.sectionHead}>
      <Text style={styles.eyebrow}>{eyebrow}</Text>
      <Text style={grocery.sectionTitle}>{title}</Text>
    </View>
  );
}

function EmptyCard({ glyph, body }: { glyph: string; body: string }) {
  return (
    <View style={grocery.emptyCard}>
      <Text style={grocery.emptyGlyph}>{glyph}</Text>
      <Text style={grocery.emptyBody}>{body}</Text>
    </View>
  );
}

const grocery = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.surface },
  scroll: {
    paddingHorizontal: space.xl,
    paddingTop: space.sm,
    paddingBottom: space.xxl,
    gap: space.lg,
  },
  head: { gap: space.sm, paddingBottom: space.sm },
  title: {
    fontFamily: fonts.display,
    fontSize: 32,
    lineHeight: 37,
    fontWeight: '700',
    color: colors.ink,
    letterSpacing: -1.1,
  },
  subtitle: { fontSize: 15, lineHeight: 22, color: colors.inkSoft, maxWidth: 340 },
  sectionHead: { gap: 3, marginTop: space.sm },
  sectionTitle: {
    fontFamily: fonts.display,
    fontSize: 22,
    lineHeight: 27,
    fontWeight: '700',
    color: colors.ink,
  },
  requestCard: {
    minHeight: 88,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    padding: space.lg,
    borderRadius: radius.md,
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.border,
    ...shadow.soft,
  },
  sourceIcon: {
    width: 42,
    height: 42,
    borderRadius: 21,
    backgroundColor: colors.brandSoft,
    alignItems: 'center',
    justifyContent: 'center',
  },
  sourceIconText: { fontSize: 16, fontWeight: '900', color: colors.brand },
  requestBody: { flex: 1, gap: 2 },
  itemName: { flexShrink: 1, fontSize: 16, lineHeight: 21, fontWeight: '800', color: colors.ink },
  meta: { fontSize: 13, lineHeight: 18, color: colors.inkSoft },
  source: { marginTop: 2, fontSize: 11, fontWeight: '800', color: colors.brand },
  requestActions: { flexDirection: 'row', gap: space.sm },
  iconButton: {
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.field,
  },
  iconButtonText: { fontSize: 24, lineHeight: 28, color: colors.inkSoft },
  approveButton: { backgroundColor: colors.accent },
  approveText: { color: colors.card, fontSize: 18, fontWeight: '900' },
  dayGroup: { gap: space.sm },
  dayLabel: { fontSize: 13, fontWeight: '900', color: colors.brand, textTransform: 'uppercase' },
  cartCard: {
    borderRadius: radius.md,
    paddingHorizontal: space.lg,
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.border,
  },
  cartRow: { minHeight: 74, flexDirection: 'row', alignItems: 'center', gap: space.md },
  cartRowBorder: { borderTopWidth: 1, borderTopColor: colors.border },
  check: {
    width: 28,
    height: 28,
    borderRadius: 9,
    borderWidth: 2,
    borderColor: colors.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  checkOn: { backgroundColor: colors.accent, borderColor: colors.accent },
  checkText: { color: colors.card, fontSize: 15, fontWeight: '900' },
  cartBody: { flex: 1, gap: 3, paddingVertical: space.md },
  itemLine: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 6 },
  emptyCard: {
    minHeight: 92,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    padding: space.lg,
    borderRadius: radius.lg,
    backgroundColor: colors.accentSoft,
  },
  emptyGlyph: { fontSize: 24, fontWeight: '900', color: colors.accent },
  emptyBody: { flex: 1, fontSize: 14, lineHeight: 20, color: colors.ink },
});

const APPROVE_BUTTON_STYLE = [grocery.iconButton, grocery.approveButton];
const CART_ROW_BORDER_STYLE = [grocery.cartRow, grocery.cartRowBorder];
const CHECKED_STYLE = [grocery.check, grocery.checkOn];
const DISABLED_CHECK_STYLE = [grocery.check, styles.disabled];
const CHECKED_DISABLED_STYLE = [grocery.check, grocery.checkOn, styles.disabled];
