import type {
  GroceryProvider,
  ProviderAddress,
  ProviderCartReview,
  ProviderCartItem,
  ProviderPaymentMethod,
  ProviderProduct,
} from '@cooklink/domain';
import { ProviderError, type UserId } from '@cooklink/domain';

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
  },
  {
    id: 'prod-tomato-1kg',
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
  },
  {
    id: 'prod-tomato-cherry',
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
  },
  {
    id: 'prod-onion-500',
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
  },
  {
    id: 'prod-toordal-500',
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
  },
  {
    id: 'prod-toordal-1kg',
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
  },
  {
    id: 'prod-milk-500',
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
  },
  // A product that is unavailable so tests can exercise AC#5 alternatives.
  {
    id: 'prod-toordal-2kg',
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
}

export function createStubProvider(options: StubProviderOptions = {}): GroceryProvider {
  const members = new Map<string, StubMemberState>();
  const availability = new Map<string, boolean>();
  if (options.availabilityOverrides) {
    for (const [pid, avail] of Object.entries(options.availabilityOverrides)) {
      availability.set(pid, avail);
    }
  }

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
  };
}
