import type { HouseholdId, MembershipId, UserId } from './ids.js';
import type { SuggestedCartItem } from './types.js';

/**
 * The Instamart (Swiggy MCP) provider port for issue 10.
 *
 * Cooklink never silently chooses brands, pack sizes, or replacements. Every
 * grocery need stays unresolved until a Member picks an exact product, and
 * every cart mutation deliberately preserves or replaces the Member's full
 * current Instamart cart.
 *
 * The real Swiggy MCP integration is gated behind production access (issue 01).
 * A local stub ({@link GroceryProvider}) makes the complete product-matching
 * journey testable without production credentials (AC#8).
 */

// ---- provider-owned types (mirror Swiggy MCP shapes) ----

/** A Swiggy/Instamart delivery address returned by `get_addresses`. */
export interface ProviderAddress {
  id: string;
  label: string; // "Home", "Work", ...
  line1: string;
  line2: string | null;
  city: string;
  pincode: string;
  lat: number;
  lng: number;
}

/**
 * An exact Instamart product returned by `search_products`, scoped to a
 * delivery address. Presents brand, variant, pack size, price, and
 * availability (AC#2). Cooklink never invents a SKU from a vague need.
 */
export interface ProviderProduct {
  /** Swiggy product id (spinId in the MCP contract). */
  id: string;
  name: string;
  brand: string;
  variant: string | null; // "500 g", "Organic", ...
  packSize: string; // "500 g", "1 L", "Pack of 6"
  priceCents: number;
  mrpCents: number;
  available: boolean;
  /** The address id this product was searched against (AC#2 scoping). */
  addressId: string;
  /** Store id when Instamart splits results across stores. */
  storeId: string;
  storeName: string;
  imageUrl: string | null;
}

/** A line item in the provider cart (after `update_cart` / `get_cart`). */
export interface ProviderCartItem {
  productId: string;
  name: string;
  brand: string;
  variant: string | null;
  packSize: string;
  quantity: number;
  priceCents: number;
  lineTotalCents: number;
  available: boolean;
  storeId: string;
  storeName: string;
}

/** A bill-breakdown line from `get_cart` (item total, delivery fee, taxes, ...). */
export interface ProviderBillLine {
  label: string;
  amountCents: number;
}

/** A payment method returned by `get_cart` (AC#6 — only these may be shown). */
export interface ProviderPaymentMethod {
  id: string;
  label: string;
  /** COD, UPI, CARD, ... — surfaced for the eligibility check. */
  kind: string;
}

/**
 * The full cart review returned by `get_cart` (AC#6). Cooklink shows every
 * item, quantity, bill breakdown, address, store count, and only the payment
 * methods the provider returned before asking for checkout confirmation.
 */
export interface ProviderCartReview {
  addressId: string;
  items: ProviderCartItem[];
  bill: ProviderBillLine[];
  totalCents: number;
  availablePaymentMethods: ProviderPaymentMethod[];
  storeCount: number;
  /** True when one or more line items became unavailable since the cart was built. */
  hasUnavailableItems: boolean;
}

// ---- provider errors ----

export type ProviderErrorCode =
  | 'not_connected'
  | 'address_not_found'
  | 'product_not_found'
  | 'product_unavailable'
  | 'cart_empty'
  | 'rate_limited'
  | 'upstream_error'
  | 'expired_session';

export class ProviderError extends Error {
  constructor(
    message: string,
    public readonly code: ProviderErrorCode,
    public readonly httpStatus?: number,
  ) {
    super(message);
    this.name = 'ProviderError';
  }
}

// ---- the provider port ----

/**
 * The Swiggy/Instamart provider interface. The server's real implementation
 * calls the Swiggy MCP; the test stub returns deterministic data (AC#8).
 *
 * Every method requires the calling member's Swiggy token context
 * (`memberSwiggyUserId`), because carts, addresses, and orders belong to the
 * authenticated member's session — not a shared household credential (AC#1).
 */
export interface GroceryProvider {
  /** Whether the member has a connected Swiggy account (delegated OAuth). */
  getConnectionStatus(
    memberUserId: UserId,
  ): Promise<{ connected: boolean; expiresAt: string | null }>;

  /**
   * Initiate delegated OAuth (AC#1). Returns the Swiggy authorization URL the
   * mobile app opens in a browser. Cooklink never receives the password or OTP.
   */
  startOAuth(args: {
    memberUserId: UserId;
    redirectUri: string;
  }): Promise<{ authorizationUrl: string; state: string }>;

  /** Complete the OAuth callback and persist the member's token. */
  completeOAuth(args: {
    memberUserId: UserId;
    code: string;
    state: string;
  }): Promise<{ connected: boolean }>;

  /** Disconnect the member's Swiggy account (revoke + delete token). */
  disconnect(memberUserId: UserId): Promise<void>;

  /** `get_addresses` — the member's saved Instamart delivery addresses. */
  getAddresses(memberUserId: UserId): Promise<ProviderAddress[]>;

  /**
   * `search_products` — scoped to `addressId`, returns exact brand/variant/
   * pack/price/availability (AC#2). A vague need yields candidate products
   * but stays unresolved until the Member chooses one (AC#3).
   */
  searchProducts(args: {
    memberUserId: UserId;
    addressId: string;
    query: string;
  }): Promise<ProviderProduct[]>;

  /**
   * `get_cart` — the member's current Instamart cart (AC#4, AC#6). Cooklink
   * must preserve or deliberately replace its full contents.
   */
  getCart(memberUserId: UserId, addressId: string): Promise<ProviderCartReview | null>;

  /**
   * `update_cart` — replaces the entire Instamart cart with the given items
   * (AC#4). The caller merges intended items with the current cart or
   * deliberately chooses replacement.
   */
  updateCart(args: {
    memberUserId: UserId;
    addressId: string;
    items: { productId: string; quantity: number }[];
  }): Promise<ProviderCartReview>;

  /**
   * Offer up to three exact available alternatives for a product that became
   * unavailable (AC#5). Requires deliberate replacement or removal.
   */
  getAlternatives(args: {
    memberUserId: UserId;
    addressId: string;
    productId: string;
  }): Promise<ProviderProduct[]>;
}

// ---- pure domain logic for product matching ----

/**
 * A Member's chosen exact product for one Suggested Grocery Cart line (AC#3).
 * A vague need (ingredient key or free-text request) remains `unresolved`
 * until the Member picks an exact product from search results.
 */
export interface ProductMatch {
  id: string;
  householdId: HouseholdId;
  cartItemId: string;
  productId: string;
  addressId: string;
  quantity: number;
  /** The exact product snapshot at selection time (brand, variant, pack, price). */
  product: ProviderProduct;
  selectedById: MembershipId;
  selectedAt: string;
}

/**
 * The resolution state for a single cart line in the product-matching journey.
 * `unresolved` means the Member has not yet chosen an exact product (AC#3).
 */
export type MatchResolution =
  | { state: 'unresolved'; cartItem: SuggestedCartItem; candidates: ProviderProduct[] }
  | { state: 'resolved'; cartItem: SuggestedCartItem; match: ProductMatch }
  | {
      state: 'unavailable';
      cartItem: SuggestedCartItem;
      match: ProductMatch;
      alternatives: ProviderProduct[];
    };

/**
 * Build the product-match plan for a Suggested Grocery Cart (AC#3).
 *
 * Each cart line is classified as:
 * - `resolved` — the Member already chose an exact product and it is still available;
 * - `unavailable` — the chosen product became unavailable; Cooklink offers up
 *   to three alternatives and requires deliberate replacement or removal (AC#5);
 * - `unresolved` — no exact product chosen yet; the need remains vague until
 *   the Member picks one.
 *
 * Cooklink NEVER silently picks a brand, pack size, or replacement.
 */
export function resolveMatchPlan(input: {
  cartItems: SuggestedCartItem[];
  matches: ProductMatch[];
  searchResults: Map<string, ProviderProduct[]>; // keyed by cartItemId
}): MatchResolution[] {
  const matchesByCart = new Map(input.matches.map((m) => [m.cartItemId, m]));
  return input.cartItems.map((cartItem) => {
    const match = matchesByCart.get(cartItem.id);
    if (match) {
      if (!match.product.available) {
        // AC#5 — the selected product became unavailable.
        const alternatives = (input.searchResults.get(cartItem.id) ?? []).filter(
          (p) => p.available && p.id !== match.productId,
        );
        return {
          state: 'unavailable' as const,
          cartItem,
          match,
          alternatives: alternatives.slice(0, 3),
        };
      }
      return { state: 'resolved' as const, cartItem, match };
    }
    // AC#3 — unresolved until the Member chooses an exact product.
    const candidates = input.searchResults.get(cartItem.id) ?? [];
    return { state: 'unresolved' as const, cartItem, candidates };
  });
}

/**
 * The Member's explicit choice when updating the Instamart cart (AC#4).
 * `update_cart` replaces the ENTIRE cart, so Cooklink must deliberately
 * preserve unrelated items or replace the whole cart — never silently erase.
 */
export type CartUpdateMode = 'preserve' | 'replace';

/**
 * Build the items list for `update_cart` according to the Member's reviewed
 * choice (AC#4).
 *
 * - `preserve` — merge Cooklink's intended items with the current cart's
 *   unrelated items (items not in the Cooklink set are kept);
 * - `replace` — the Member reviewed the full current cart and chose to replace
 *   it entirely with Cooklink's intended items.
 *
 * Returns the final item list and a summary of what was kept/dropped so the
 * review screen can show the Member the consequences before confirming.
 */
export function buildCartUpdatePlan(input: {
  currentItems: ProviderCartItem[];
  intendedItems: { productId: string; quantity: number }[];
  mode: CartUpdateMode;
}): {
  items: { productId: string; quantity: number }[];
  preservedCount: number;
  replacedCount: number;
} {
  if (input.mode === 'replace') {
    return {
      items: input.intendedItems,
      preservedCount: 0,
      replacedCount: input.currentItems.length,
    };
  }
  // preserve: keep current items that are NOT in the intended set, then add
  // (or update quantity for) the intended items.
  const intendedIds = new Set(input.intendedItems.map((i) => i.productId));
  const preserved = input.currentItems.filter((item) => !intendedIds.has(item.productId));
  return {
    items: [
      ...preserved.map((item) => ({ productId: item.productId, quantity: item.quantity })),
      ...input.intendedItems,
    ],
    preservedCount: preserved.length,
    replacedCount: 0,
  };
}

/**
 * Validate that a cart review is complete enough for Member confirmation
 * (AC#6). Cooklink must show every item, quantity, bill breakdown, address,
 * store count, and only payment methods returned by the provider.
 */
export function validateCartReview(review: ProviderCartReview): {
  valid: boolean;
  missing: string[];
} {
  const missing: string[] = [];
  if (!review.addressId) missing.push('address');
  if (review.items.length === 0) missing.push('items');
  if (review.bill.length === 0) missing.push('bill');
  if (review.totalCents < 0) missing.push('total');
  if (review.storeCount < 1) missing.push('store_count');
  // AC#6 — only payment methods returned by the provider may be shown.
  // An empty list is valid (it routes to the Instamart-app fallback).
  return { valid: missing.length === 0, missing };
}

/**
 * Whether all cart lines are resolved to an exact, available product (AC#3).
 * The checkout review must not proceed while any line is unresolved or
 * unavailable.
 */
export function allResolved(plan: MatchResolution[]): boolean {
  return plan.every((r) => r.state === 'resolved');
}

/**
 * The query string for searching products for a cart line. Uses the
 * free-text item when present (Cook's Grocery Request), otherwise the
 * ingredient key's human-readable form.
 */
export function searchQueryFor(cartItem: SuggestedCartItem): string {
  if (cartItem.freeTextItem) return cartItem.freeTextItem;
  if (cartItem.ingredientKey) return cartItem.ingredientKey.replace(/_/g, ' ');
  return '';
}
