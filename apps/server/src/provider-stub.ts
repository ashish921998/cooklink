import type {
  GroceryProvider,
  ProviderAddress,
  ProviderCartReview,
  ProviderCartItem,
  ProviderOrder,
  ProviderOrderItem,
  ProviderPaymentMethod,
  ProviderProduct,
} from '@cooklink/domain';
import { ProviderError, classifyCheckoutResult, type UserId } from '@cooklink/domain';

/**
 * A local, deterministic Instamart provider stub (issue 10, AC#8).
 *
 * It implements the full {@link GroceryProvider} contract so the complete
 * product-matching journey — OAuth, address selection, product search, exact
 * product choice, cart preserve/replace, review, and alternative replacement —
 * is testable without production Swiggy credentials.
 *
 * The stub never makes a network call. It keeps per-member state (connection,
 * cart) in memory and returns a small fixed catalog scoped to the stub
 * address. Product availability can be toggled at construction time so tests
 * can exercise the unavailable-product → alternatives flow (AC#5).
 */

interface StubMemberState {
  connected: boolean;
  expiresAt: string | null;
  cart: Map<string, ProviderCartItem>; // productId -> item
  addressId: string;
  /** Orders placed by this member through the stub (issue 11, AC#6/AC#8). */
  orders: ProviderOrder[];
  /** Idempotency keys already seen by place_order (AC#5 — no blind duplicate). */
  placedKeys: Set<string>;
}

const STUB_ADDRESSES: ProviderAddress[] = [
  {
    id: 'addr-home',
    label: 'Home',
    line1: '12 Brigade Road',
    line2: 'Ashok Nagar',
    city: 'Bengaluru',
    pincode: '560025',
    lat: 12.9716,
    lng: 77.5946,
  },
  {
    id: 'addr-work',
    label: 'Work',
    line1: '90 Outer Ring Road',
    line2: null,
    city: 'Bengaluru',
    pincode: '560103',
    lat: 12.9352,
    lng: 77.6245,
  },
];

/** Deterministic stub products for the home address. */
const STUB_PRODUCTS: ProviderProduct[] = [
  {
    id: 'prod-tomato-500',
    skuId: 'sku-tomato-500',
    name: 'Tomato',
    brand: 'Fresh Farms',
    variant: 'Ripe',
    packSize: '500 g',
    priceCents: 3000,
    mrpCents: 3500,
    available: true,
    addressId: 'addr-home',
    storeId: 'store-1',
    storeName: 'Instamart Store 1',
    imageUrl: null,
    similar: false,
  },
  {
    id: 'prod-tomato-1kg',
    skuId: 'sku-tomato-1kg',
    name: 'Tomato',
    brand: 'Fresh Farms',
    variant: 'Ripe',
    packSize: '1 kg',
    priceCents: 5500,
    mrpCents: 6000,
    available: true,
    addressId: 'addr-home',
    storeId: 'store-1',
    storeName: 'Instamart Store 1',
    imageUrl: null,
    similar: false,
  },
  {
    id: 'prod-tomato-cherry',
    skuId: 'sku-tomato-cherry',
    name: 'Cherry Tomato',
    brand: 'Pure Veg',
    variant: 'Cherry',
    packSize: '250 g',
    priceCents: 4500,
    mrpCents: 5000,
    available: true,
    addressId: 'addr-home',
    storeId: 'store-1',
    storeName: 'Instamart Store 1',
    imageUrl: null,
    similar: true,
  },
  {
    id: 'prod-onion-500',
    skuId: 'sku-onion-500',
    name: 'Onion',
    brand: 'Fresh Farms',
    variant: null,
    packSize: '500 g',
    priceCents: 2500,
    mrpCents: 3000,
    available: true,
    addressId: 'addr-home',
    storeId: 'store-1',
    storeName: 'Instamart Store 1',
    imageUrl: null,
    similar: false,
  },
  {
    id: 'prod-toordal-500',
    skuId: 'sku-toordal-500',
    name: 'Toor Dal',
    brand: 'Tata Sampann',
    variant: 'Unpolished',
    packSize: '500 g',
    priceCents: 8500,
    mrpCents: 9500,
    available: true,
    addressId: 'addr-home',
    storeId: 'store-2',
    storeName: 'Instamart Store 2',
    imageUrl: null,
    similar: false,
  },
  {
    id: 'prod-toordal-1kg',
    skuId: 'sku-toordal-1kg',
    name: 'Toor Dal',
    brand: 'Tata Sampann',
    variant: 'Unpolished',
    packSize: '1 kg',
    priceCents: 16000,
    mrpCents: 18000,
    available: true,
    addressId: 'addr-home',
    storeId: 'store-2',
    storeName: 'Instamart Store 2',
    imageUrl: null,
    similar: false,
  },
  {
    id: 'prod-milk-500',
    skuId: 'sku-milk-500',
    name: 'Toned Milk',
    brand: 'Nandini',
    variant: 'Toned',
    packSize: '500 ml',
    priceCents: 2800,
    mrpCents: 3000,
    available: true,
    addressId: 'addr-home',
    storeId: 'store-1',
    storeName: 'Instamart Store 1',
    imageUrl: null,
    similar: false,
  },
  // A product that is unavailable so tests can exercise AC#5 alternatives.
  {
    id: 'prod-toordal-2kg',
    skuId: 'sku-toordal-2kg',
    name: 'Toor Dal',
    brand: 'Organic Tattva',
    variant: 'Organic',
    packSize: '2 kg',
    priceCents: 32000,
    mrpCents: 35000,
    available: false,
    addressId: 'addr-home',
    storeId: 'store-2',
    storeName: 'Instamart Store 2',
    imageUrl: null,
    similar: true,
  },
];

const STUB_PAYMENT_METHODS: ProviderPaymentMethod[] = [
  { id: 'pm-cod', label: 'Cash on Delivery', kind: 'COD' },
];

export interface StubProviderOptions {
  /**
   * Override product availability by id. Keys not present keep their default.
   * Useful for testing the AC#5 unavailable-product flow.
   */
  availabilityOverrides?: Record<string, boolean>;
  /**
   * Simulate a network/server uncertainty on the Nth `place_order` call
   * (issue 11, AC#6). The call throws a `ProviderError('upstream_error')` so
   * the server must consult `get_orders` before retrying. The order is still
   * recorded internally so `get_orders` can prove whether it was placed.
   */
  failPlaceOrderOnAttempt?: number;
  /**
   * When set, the first `place_order` for a multi-store cart records only the
   * first store as placed and the rest as failed (issue 11, AC#7 — partial
   * success is shown per resulting order, not as one misleading result).
   */
  simulateMultiStorePartialFailure?: boolean;
}

export function createStubProvider(options: StubProviderOptions = {}): GroceryProvider {
  const members = new Map<string, StubMemberState>();
  const availability = new Map<string, boolean>();
  if (options.availabilityOverrides) {
    for (const [pid, avail] of Object.entries(options.availabilityOverrides)) {
      availability.set(pid, avail);
    }
  }
  let placeOrderCallCount = 0;

  function memberKey(userId: UserId): string {
    return userId as string;
  }
  function getMember(userId: UserId): StubMemberState | null {
    return members.get(memberKey(userId)) ?? null;
  }
  function ensureMember(userId: UserId): StubMemberState {
    const m = getMember(userId);
    if (!m) throw new ProviderError('Swiggy account not connected', 'not_connected');
    return m;
  }
  function productAvail(p: ProviderProduct): boolean {
    return availability.get(p.id) ?? p.available;
  }
  function toCartItem(p: ProviderProduct, qty: number): ProviderCartItem {
    return {
      productId: p.id,
      skuId: p.skuId,
      name: p.name,
      brand: p.brand,
      variant: p.variant,
      packSize: p.packSize,
      quantity: qty,
      priceCents: p.priceCents,
      lineTotalCents: p.priceCents * qty,
      available: productAvail(p),
      storeId: p.storeId,
      storeName: p.storeName,
    };
  }
  function buildReview(addr: string, items: ProviderCartItem[]): ProviderCartReview {
    const subtotal = items.reduce((sum, i) => sum + i.lineTotalCents, 0);
    const deliveryFee = subtotal > 0 ? 2500 : 0; // ₹25
    const storeIds = new Set(items.map((i) => i.storeId));
    const hasUnavailable = items.some((i) => !i.available);
    return {
      addressId: addr,
      items,
      bill: [
        { label: 'Item total', amountCents: subtotal },
        { label: 'Delivery fee', amountCents: deliveryFee },
        { label: 'Total', amountCents: subtotal + deliveryFee },
      ],
      totalCents: subtotal + deliveryFee,
      availablePaymentMethods: STUB_PAYMENT_METHODS,
      storeCount: storeIds.size || 1,
      hasUnavailableItems: hasUnavailable,
    };
  }

  return {
    async getConnectionStatus(memberUserId: UserId) {
      const m = getMember(memberUserId);
      return m
        ? { connected: m.connected, expiresAt: m.expiresAt }
        : { connected: false, expiresAt: null };
    },

    async startOAuth({ memberUserId, redirectUri }) {
      // The stub returns a deterministic URL. The state encodes the member so
      // completeOAuth can find them.
      const state = `stub-${memberUserId as string}`;
      const url = `https://mcp-staging.swiggy.com/oauth/authorize?redirect_uri=${encodeURIComponent(redirectUri)}&state=${state}`;
      // Pre-register the member so completeOAuth can find them.
      if (!getMember(memberUserId)) {
        members.set(memberKey(memberUserId), {
          connected: false,
          expiresAt: null,
          cart: new Map(),
          addressId: STUB_ADDRESSES[0]!.id,
          orders: [],
          placedKeys: new Set(),
        });
      }
      return { authorizationUrl: url, state };
    },

    async completeOAuth({ memberUserId }) {
      const m = getMember(memberUserId);
      if (!m) throw new ProviderError('OAuth session not started', 'expired_session');
      const expires = new Date();
      expires.setDate(expires.getDate() + 5); // 5-day access token
      m.connected = true;
      m.expiresAt = expires.toISOString();
      return { connected: true };
    },

    async disconnect(memberUserId: UserId) {
      members.delete(memberKey(memberUserId));
    },

    async getAddresses(memberUserId: UserId) {
      ensureMember(memberUserId);
      return STUB_ADDRESSES;
    },

    async searchProducts({ memberUserId, addressId, query }) {
      ensureMember(memberUserId);
      const q = query.toLowerCase().trim();
      if (!q) return [];
      const results = STUB_PRODUCTS.filter(
        (p) =>
          p.addressId === addressId &&
          (p.name.toLowerCase().includes(q) ||
            p.brand.toLowerCase().includes(q) ||
            (p.variant?.toLowerCase().includes(q) ?? false)),
      ).map((p) => ({ ...p, available: productAvail(p) }));
      return results;
    },

    async getCart(memberUserId: UserId, addressId: string) {
      const m = ensureMember(memberUserId);
      const items = [...m.cart.values()];
      if (items.length === 0) return null;
      return buildReview(addressId, items);
    },

    async updateCart({ memberUserId, addressId, items }) {
      const m = ensureMember(memberUserId);
      const newCart = new Map<string, ProviderCartItem>();
      for (const entry of items) {
        const p = STUB_PRODUCTS.find((sp) => sp.id === entry.productId);
        if (!p) throw new ProviderError('Product not found', 'product_not_found');
        newCart.set(
          entry.productId,
          toCartItem({ ...p, available: productAvail(p) }, entry.quantity),
        );
      }
      m.cart = newCart;
      m.addressId = addressId;
      return buildReview(addressId, [...newCart.values()]);
    },

    async clearCart(memberUserId, addressId) {
      const member = ensureMember(memberUserId);
      member.cart.clear();
      member.addressId = addressId;
    },

    async getAlternatives({ memberUserId, addressId, productId }) {
      ensureMember(memberUserId);
      const original = STUB_PRODUCTS.find((p) => p.id === productId);
      if (!original) throw new ProviderError('Product not found', 'product_not_found');
      // Return up to 3 available products with the same name (different brand/
      // pack/variant) at the same address, excluding the original.
      const alts = STUB_PRODUCTS.filter(
        (p) =>
          p.id !== productId &&
          p.addressId === addressId &&
          p.name === original.name &&
          productAvail(p),
      )
        .slice(0, 3)
        .map((p) => ({ ...p, available: productAvail(p) }));
      return alts;
    },

    async placeOrder({ memberUserId, addressId, paymentMethodId, idempotencyKey }) {
      const m = ensureMember(memberUserId);
      void addressId;
      // AC#5 — a unique checkout attempt: a repeated idempotency key must not
      // place a second order. The stub records the key and, on a repeat,
      // surfaces the prior result deterministically.
      if (m.placedKeys.has(idempotencyKey)) {
        const prior = m.orders.filter(
          (o) => (o as unknown as { _key?: string })._key === idempotencyKey,
        );
        if (prior.length > 0) {
          const { allSucceeded, partialSuccess } = classifyCheckoutResult(prior);
          return { orders: prior, allSucceeded, partialSuccess };
        }
      }

      const items = [...m.cart.values()];
      if (items.length === 0) throw new ProviderError('Cart is empty', 'cart_empty');

      // Validate the payment method is one the provider returned (AC#1/AC#3).
      const pm = STUB_PAYMENT_METHODS.find((p) => p.id === paymentMethodId);
      if (!pm) {
        throw new ProviderError('Payment method not available', 'payment_method_unavailable', 400);
      }

      // Group line items by store → one ProviderOrder per resulting store
      // (issue 11, AC#7 — multi-store partial success shown per order).
      const byStore = new Map<string, ProviderCartItem[]>();
      for (const item of items) {
        const bucket = byStore.get(item.storeId) ?? [];
        bucket.push(item);
        byStore.set(item.storeId, bucket);
      }

      const placedAt = new Date().toISOString();
      const cancellableUntil = new Date(Date.now() + 5 * 60_000).toISOString();
      const deliveryEta = new Date(Date.now() + 60 * 60_000).toISOString();
      const policy = 'Cancellable within 5 minutes of placing via the Instamart app.';

      const storeEntries = [...byStore.entries()];
      const orders: ProviderOrder[] = storeEntries.map(([storeId, storeItems], idx) => {
        const storeName = storeItems[0]!.storeName;
        const orderItems: ProviderOrderItem[] = storeItems.map((i) => ({
          productId: i.productId,
          name: i.name,
          quantity: i.quantity,
          lineTotalCents: i.lineTotalCents,
          storeId,
          storeName,
        }));
        const total = storeItems.reduce((sum, i) => sum + i.lineTotalCents, 0);
        // AC#7 — simulate a partial multi-store failure on the first attempt.
        const failed =
          options.simulateMultiStorePartialFailure && storeEntries.length > 1 && idx > 0;
        const order: ProviderOrder = {
          id: `ord-${memberUserId as string}-${m.orders.length + idx}`,
          status: failed ? 'failed' : 'placed',
          storeId,
          storeName,
          totalCents: total,
          items: orderItems,
          placedAt,
          deliveryEta: failed ? null : deliveryEta,
          trackingUrl: failed
            ? null
            : `https://instamart.swiggy.com/track/ord-${m.orders.length + idx}`,
          cancellableUntil: failed ? null : cancellableUntil,
          cancellationPolicy: policy,
        };
        // Tag the order with its idempotency key so a repeat returns the same
        // result instead of placing again (AC#5).
        (order as unknown as { _key?: string })._key = idempotencyKey;
        return order;
      });

      // AC#6 — simulate a network/server uncertainty. The order is recorded
      // internally BEFORE the throw so `get_orders` can prove whether it was
      // placed; the server must consult get_orders before retrying.
      placeOrderCallCount += 1;
      const recordOrders = () => {
        m.placedKeys.add(idempotencyKey);
        for (const o of orders) m.orders.push(o);
      };
      if (
        options.failPlaceOrderOnAttempt === placeOrderCallCount &&
        options.failPlaceOrderOnAttempt > 0
      ) {
        // Uncertainty: the request may or may not have reached the provider.
        // Record the order (it was placed) but surface an upstream_error so
        // the caller must verify via get_orders before retrying (AC#6).
        recordOrders();
        throw new ProviderError('Checkout uncertainty — verify via get_orders', 'upstream_error');
      }

      recordOrders();
      const { allSucceeded, partialSuccess } = classifyCheckoutResult(orders);
      return { orders, allSucceeded, partialSuccess };
    },

    async getOrders(memberUserId: UserId) {
      const m = ensureMember(memberUserId);
      // Return copies without the internal _key tag (issue 11, AC#6/AC#8).
      return m.orders.map(({ ...o }) => {
        delete (o as unknown as { _key?: string })._key;
        return o;
      });
    },
  };
}
