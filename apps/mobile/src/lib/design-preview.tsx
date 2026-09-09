import { useCallback, useRef, type ReactNode } from 'react';
import { ApiRequestOverrideContext, ApiTokenResolverContext, type ApiRequest } from './api';
import type { TimelineItem } from './chat';
import type { PlannedMeal } from './households';
import type { InstamartCartReview, InstamartOrder, InstamartProduct } from './instamart';

const MEALS: Record<PlannedMeal['mealType'], string[]> = {
  breakfast: ['Poha', 'Besan Chilla', 'Idli Sambar', 'Aloo Paratha', 'Upma', 'Dosa', 'Pongal'],
  lunch: ['Dal Tadka', 'Rajma', 'Chole', 'Kadhi Pakora', 'Aloo Gobi', 'Lemon Rice', 'Sambar Sadam'],
  dinner: [
    'Paneer Bhurji',
    'Mix Veg',
    'Dal Makhani',
    'Baingan Bharta',
    'Jeera Aloo',
    'Tomato Rice',
    'Vegetable Stew',
  ],
};

function dateAt(offset: number): string {
  const date = new Date();
  date.setHours(12, 0, 0, 0);
  date.setDate(date.getDate() + offset);
  return date.toISOString().slice(0, 10);
}

function fixtureMeals(): PlannedMeal[] {
  const rows: PlannedMeal[] = [];
  (['breakfast', 'lunch', 'dinner'] as const).forEach((mealType) => {
    MEALS[mealType].forEach((name, day) => {
      rows.push({
        id: `${day}-${mealType}`,
        date: dateAt(day),
        mealType,
        name,
        servings: 4,
        servingsOverridden: false,
        isSpecial: day === 5 && mealType === 'dinner',
        version: 1,
        recipeId: name === 'Dal Tadka' ? 'recipe-dal' : null,
      });
    });
  });
  return rows.sort((a, b) => a.date.localeCompare(b.date));
}

const DAL_RECIPE = {
  id: 'recipe-dal',
  name: 'Dal Tadka',
  nameHi: 'दाल तड़का',
  steps: [
    'Rinse the dal, then simmer it with turmeric until soft.',
    'Warm ghee and bloom cumin, garlic, chilli, and asafoetida.',
    'Pour the hot tadka over the dal, season, and serve immediately.',
  ],
  stepsHi: null,
  provenance: 'verified' as const,
  servings: 4,
  ingredients: [
    { name: 'Toor dal', display: 'Toor dal — 200g', dependable: true },
    { name: 'Tomato', display: 'Tomato — 3', dependable: true },
    { name: 'Cumin', display: 'Cumin — adjust to taste', dependable: false },
    { name: 'Salt', display: 'Salt — adjust to taste', dependable: false },
  ],
};

function previewChatItems(): TimelineItem[] {
  const at = (minutesAgo: number) => new Date(Date.now() - minutesAgo * 60_000).toISOString();
  return [
    {
      kind: 'message',
      id: 'preview-chat-1',
      householdId: 'preview-household',
      senderId: 'preview-cook',
      sender: { displayName: 'Meena', role: 'cook', active: true },
      messageKind: 'text',
      body: "Good morning! Dal Tadka is on for lunch. We're low on tomatoes.",
      caption: null,
      mediaRef: null,
      transcript: null,
      transcriptText: null,
      transcriptAutomatic: false,
      deletedAt: null,
      editedAt: null,
      clientCreatedAt: at(34),
      serverCreatedAt: at(34),
    },
    {
      kind: 'event',
      id: 'preview-chat-event-1',
      householdId: 'preview-household',
      type: 'grocery_request_created',
      actorId: 'preview-cook',
      actor: { displayName: 'Meena', role: 'cook', active: true },
      entityType: 'grocery_request',
      entityId: 'request-tomatoes',
      payload: { item: 'Tomatoes', quantity: '1 kg' },
      text: 'Meena requested 1 kg of tomatoes',
      createdAt: at(32),
    },
    {
      kind: 'message',
      id: 'preview-chat-2',
      householdId: 'preview-household',
      senderId: 'preview-member',
      sender: { displayName: 'Riya', role: 'member', active: true },
      messageKind: 'text',
      body: 'Added them to the grocery plan. Thank you!',
      caption: null,
      mediaRef: null,
      transcript: null,
      transcriptText: null,
      transcriptAutomatic: false,
      deletedAt: null,
      editedAt: null,
      clientCreatedAt: at(28),
      serverCreatedAt: at(28),
    },
    {
      kind: 'message',
      id: 'preview-chat-3',
      householdId: 'preview-household',
      senderId: 'preview-cook',
      sender: { displayName: 'Meena', role: 'cook', active: true },
      messageKind: 'voice',
      body: null,
      caption: null,
      mediaRef: 'preview-voice-note',
      transcript: {
        language: 'en',
        transcript: 'Perfect. I will prep the dal before noon.',
        status: 'ready',
        correctedTranscript: null,
      },
      transcriptText: 'Perfect. I will prep the dal before noon.',
      transcriptAutomatic: true,
      deletedAt: null,
      editedAt: null,
      clientCreatedAt: at(24),
      serverCreatedAt: at(24),
    },
  ];
}

type PreviewState = {
  meals: PlannedMeal[];
  requests: Array<Record<string, unknown>>;
  cart: Array<Record<string, unknown>>;
  productMatches: Record<string, InstamartProduct>;
  providerCart: InstamartCartReview | null;
  providerOrders: InstamartOrder[];
};

const PREVIEW_PRODUCTS: Record<string, InstamartProduct[]> = {
  'cart-tomato': [
    {
      id: 'spin-tomato-500',
      skuId: 'sku-tomato-500',
      name: 'Tomatoes',
      brand: 'Fresh Farms',
      variant: 'Ripe',
      packSize: '500 g',
      priceCents: 3000,
      mrpCents: 3500,
      available: true,
      addressId: 'addr-home',
      storeId: 'store-1',
      storeName: 'Instamart Brigade',
      imageUrl: null,
      similar: false,
    },
    {
      id: 'spin-tomato-1kg',
      skuId: 'sku-tomato-1kg',
      name: 'Tomatoes',
      brand: 'Fresh Farms',
      variant: 'Ripe',
      packSize: '1 kg',
      priceCents: 5500,
      mrpCents: 6000,
      available: true,
      addressId: 'addr-home',
      storeId: 'store-1',
      storeName: 'Instamart Brigade',
      imageUrl: null,
      similar: false,
    },
  ],
  'cart-toor-dal': [
    {
      id: 'spin-dal-500',
      skuId: 'sku-dal-500',
      name: 'Toor Dal',
      brand: 'Tata Sampann',
      variant: 'Unpolished',
      packSize: '500 g',
      priceCents: 8500,
      mrpCents: 9500,
      available: true,
      addressId: 'addr-home',
      storeId: 'store-2',
      storeName: 'Instamart Central',
      imageUrl: null,
      similar: false,
    },
  ],
  'cart-paneer': [
    {
      id: 'spin-paneer-200',
      skuId: 'sku-paneer-200',
      name: 'Fresh Paneer',
      brand: 'Milky Mist',
      variant: null,
      packSize: '200 g',
      priceCents: 9500,
      mrpCents: 10500,
      available: true,
      addressId: 'addr-home',
      storeId: 'store-1',
      storeName: 'Instamart Brigade',
      imageUrl: null,
      similar: false,
    },
  ],
};

const resolvePreviewToken = async () => null;

/** Local-only API used when EXPO_PUBLIC_COOKLINK_DESIGN_PREVIEW=true. */
export function DesignPreviewApiProvider({ children }: { children: ReactNode }) {
  const state = useRef<PreviewState>({
    meals: fixtureMeals(),
    requests: [
      {
        id: 'request-tomatoes',
        householdId: 'preview-household',
        itemText: 'Tomatoes',
        quantityText: '1 kg',
        status: 'pending',
        createdById: 'preview-cook',
        createdAt: new Date().toISOString(),
        resolvedById: null,
        resolvedAt: null,
        version: 1,
      },
    ],
    cart: [
      {
        id: 'cart-tomato',
        ingredientKey: 'tomato',
        groceryRequestId: 'request-tomatoes',
        freeTextItem: 'Tomatoes',
        needDay: 'today',
        affectedMeals: [],
        confidence: 'unknown',
        memberState: 'pending',
        removalReason: null,
        checkAtHome: true,
      },
      {
        id: 'cart-toor-dal',
        ingredientKey: 'toor_dal',
        groceryRequestId: null,
        freeTextItem: null,
        needDay: 'tomorrow',
        affectedMeals: [{ date: dateAt(1), mealType: 'lunch', name: 'Dal Tadka' }],
        confidence: 'may_be_low',
        memberState: 'kept',
        removalReason: null,
        checkAtHome: true,
      },
      {
        id: 'cart-paneer',
        ingredientKey: 'paneer',
        groceryRequestId: null,
        freeTextItem: null,
        needDay: 'day_after',
        affectedMeals: [{ date: dateAt(2), mealType: 'dinner', name: 'Paneer Bhurji' }],
        confidence: 'likely_available',
        memberState: 'pending',
        removalReason: null,
        checkAtHome: false,
      },
    ],
    productMatches: {},
    providerCart: null,
    providerOrders: [],
  });

  const request = useCallback<ApiRequest>(async (path, init) => {
    if (path.endsWith('/access')) return { ok: true, membershipId: 'preview-member' } as never;
    if (path.includes('/chat/suggestions')) return { suggestions: [] } as never;
    if (path.endsWith('/chat/read') && init?.method === 'POST') return { ok: true } as never;
    if (path.includes('/chat?')) {
      return { items: path.includes('afterId=') ? [] : previewChatItems() } as never;
    }
    if (path.endsWith('/meal-plan')) return { meals: state.current.meals } as never;
    if (path.includes('/meal-plan/meals/') && path.endsWith('/recipe')) {
      const mealId = path.split('/').at(-2);
      const meal = state.current.meals.find((row) => row.id === mealId);
      return { recipe: meal?.recipeId === 'recipe-dal' ? DAL_RECIPE : null } as never;
    }
    if (path.includes('/grocery-requests') && (!init?.method || init.method === 'GET')) {
      return { requests: state.current.requests } as never;
    }
    if (path.includes('/grocery-requests/') && path.endsWith('/resolve')) {
      const requestId = path.split('/').at(-2);
      state.current.requests = state.current.requests.filter((row) => row.id !== requestId);
      return { request: null, orderNow: false } as never;
    }
    if (path.endsWith('/suggested-cart')) return { items: state.current.cart } as never;
    if (path.includes('/suggested-cart/') && init?.method === 'PATCH') {
      const itemId = path.split('/').at(-1);
      const patch = JSON.parse(String(init.body ?? '{}')) as { state?: 'kept' | 'removed' };
      state.current.cart = state.current.cart.map((row) =>
        row.id === itemId ? { ...row, memberState: patch.state ?? row.memberState } : row,
      );
      return { item: state.current.cart.find((row) => row.id === itemId) } as never;
    }
    if (path.endsWith('/grocery-provider/status')) {
      return {
        connected: true,
        expiresAt: new Date(Date.now() + 5 * 86_400_000).toISOString(),
      } as never;
    }
    if (path.endsWith('/grocery-provider/addresses')) {
      return {
        addresses: [
          {
            id: 'addr-home',
            label: 'Home',
            line1: '12 Brigade Road',
            line2: 'Ashok Nagar',
            city: 'Bengaluru',
            pincode: '560025',
            lat: null,
            lng: null,
          },
          {
            id: 'addr-work',
            label: 'Work',
            line1: '90 Outer Ring Road',
            line2: null,
            city: 'Bengaluru',
            pincode: '560103',
            lat: null,
            lng: null,
          },
        ],
      } as never;
    }
    if (path.includes('/grocery-provider/match-plan') && (!init?.method || init.method === 'GET')) {
      const active = state.current.cart.filter((row) => row.memberState !== 'removed');
      return {
        plan: active.map((row) => {
          const cartItemId = String(row.id);
          const product = state.current.productMatches[cartItemId];
          return product
            ? {
                state: 'resolved',
                cartItem: row,
                match: {
                  id: `match-${cartItemId}`,
                  cartItemId,
                  productId: product.id,
                  addressId: product.addressId,
                  quantity: 1,
                  product,
                },
              }
            : {
                state: 'unresolved',
                cartItem: row,
                candidates: PREVIEW_PRODUCTS[cartItemId] ?? [],
              };
        }),
        allResolved: active.every((row) => Boolean(state.current.productMatches[String(row.id)])),
      } as never;
    }
    if (path.endsWith('/grocery-provider/match') && init?.method === 'POST') {
      const body = JSON.parse(String(init.body ?? '{}')) as {
        cartItemId: string;
        productId: string;
      };
      const product = (PREVIEW_PRODUCTS[body.cartItemId] ?? []).find(
        (candidate) => candidate.id === body.productId,
      );
      if (!product) throw new Error('Preview product not found');
      state.current.productMatches[body.cartItemId] = product;
      return { match: { cartItemId: body.cartItemId, productId: product.id, product } } as never;
    }
    if (path.includes('/grocery-provider/match/') && init?.method === 'DELETE') {
      const cartItemId = path.split('/').at(-1);
      if (cartItemId) delete state.current.productMatches[cartItemId];
      return { ok: true } as never;
    }
    if (path.endsWith('/grocery-provider/cart/build') && init?.method === 'POST') {
      state.current.providerCart = buildPreviewProviderCart(state.current.productMatches);
      return { review: state.current.providerCart, mode: 'preserve' } as never;
    }
    if (path.includes('/grocery-provider/cart?') && (!init?.method || init.method === 'GET')) {
      return {
        review: state.current.providerCart,
        valid: Boolean(state.current.providerCart),
      } as never;
    }
    if (path.endsWith('/grocery-provider/checkout/confirm') && init?.method === 'POST') {
      const body = JSON.parse(String(init.body ?? '{}')) as { paymentMethodId: string };
      const review = state.current.providerCart;
      if (!review) throw new Error('Preview cart is empty');
      return {
        confirmation: {
          token: 'preview-confirmation',
          addressId: review.addressId,
          paymentMethodId: body.paymentMethodId,
          storeCount: review.storeCount,
          totalCents: review.totalCents,
          itemCount: review.items.length,
          issuedAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        },
        review,
        eligibility: { eligible: true, reason: 'eligible', fallback: null },
        orderingEnabled: true,
      } as never;
    }
    if (path.endsWith('/grocery-provider/checkout') && init?.method === 'POST') {
      const review = state.current.providerCart;
      if (!review) throw new Error('Preview cart is empty');
      const order: InstamartOrder = {
        id: 'preview-order-1',
        providerOrderId: 'IM-PREVIEW-1',
        localStatus: 'placed',
        providerStatus: 'placed',
        totalCents: review.totalCents,
        createdAt: new Date().toISOString(),
        tracking: {
          trackingUrl: 'https://www.swiggy.com/instamart',
          deliveryEta: new Date(Date.now() + 20 * 60_000).toISOString(),
          storeName: 'Instamart',
          storeCount: review.storeCount,
        },
      };
      state.current.providerOrders = [order];
      return {
        result: 'succeeded',
        orders: [{ id: order.providerOrderId, status: 'placed' }],
      } as never;
    }
    if (path.endsWith('/grocery-provider/orders')) {
      return { orders: state.current.providerOrders } as never;
    }
    if (path.endsWith('/grocery-provider/disconnect') && init?.method === 'POST') {
      return { connected: false } as never;
    }
    if (path.endsWith('/members')) return { members: [] } as never;
    if (path.endsWith('/invites')) return { invites: [] } as never;
    if (path.endsWith('/meal-plan/search')) return { results: [] } as never;
    throw new Error(`Design preview has no fixture for ${init?.method ?? 'GET'} ${path}`);
  }, []);

  return (
    <ApiTokenResolverContext.Provider value={resolvePreviewToken}>
      <ApiRequestOverrideContext.Provider value={request}>
        {children}
      </ApiRequestOverrideContext.Provider>
    </ApiTokenResolverContext.Provider>
  );
}

function buildPreviewProviderCart(matches: Record<string, InstamartProduct>): InstamartCartReview {
  const products = Object.values(matches);
  const items = products.map((product) => ({
    productId: product.id,
    skuId: product.skuId,
    name: product.name,
    brand: product.brand,
    variant: product.variant,
    packSize: product.packSize,
    quantity: 1,
    priceCents: product.priceCents,
    lineTotalCents: product.priceCents,
    available: product.available,
    storeId: product.storeId,
    storeName: product.storeName,
  }));
  const subtotal = items.reduce((sum, item) => sum + item.lineTotalCents, 0);
  const delivery = 2500;
  return {
    addressId: 'addr-home',
    items,
    bill: [
      { label: 'Item total', amountCents: subtotal },
      { label: 'Delivery fee', amountCents: delivery },
      { label: 'Total', amountCents: subtotal + delivery },
    ],
    totalCents: subtotal + delivery,
    availablePaymentMethods: [{ id: 'pm-cod', label: 'Cash on Delivery', kind: 'COD' }],
    storeCount: new Set(items.map((item) => item.storeId)).size || 1,
    hasUnavailableItems: false,
  };
}
