export type InstamartAddress = {
  id: string;
  label: string;
  line1: string;
  line2: string | null;
  city: string;
  pincode: string;
  lat: number | null;
  lng: number | null;
};

export type InstamartProduct = {
  id: string;
  skuId?: string | null;
  name: string;
  brand: string;
  variant: string | null;
  packSize: string;
  priceCents: number;
  mrpCents: number;
  available: boolean;
  addressId: string;
  storeId: string;
  storeName: string;
  imageUrl: string | null;
  similar?: boolean;
};

export type InstamartCartNeed = {
  id: string;
  freeTextItem: string | null;
  ingredientKey: string | null;
};

export type InstamartProductMatch = {
  id: string;
  cartItemId: string;
  productId: string;
  addressId: string;
  quantity: number;
  product: InstamartProduct;
};

export type InstamartMatchResolution =
  | {
      state: 'unresolved';
      cartItem: InstamartCartNeed;
      candidates: InstamartProduct[];
    }
  | {
      state: 'resolved';
      cartItem: InstamartCartNeed;
      match: InstamartProductMatch;
    }
  | {
      state: 'unavailable';
      cartItem: InstamartCartNeed;
      match: InstamartProductMatch;
      alternatives: InstamartProduct[];
    };

export type InstamartCartItem = {
  productId: string;
  skuId?: string | null;
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
};

export type InstamartPaymentMethod = {
  id: string;
  label: string;
  kind: string;
};

export type InstamartCartReview = {
  addressId: string;
  items: InstamartCartItem[];
  bill: { label: string; amountCents: number }[];
  totalCents: number;
  availablePaymentMethods: InstamartPaymentMethod[];
  storeCount: number;
  hasUnavailableItems: boolean;
};

export type InstamartCheckoutConfirmation = {
  token: string;
  addressId: string;
  paymentMethodId: string;
  storeCount: number;
  totalCents: number;
  itemCount: number;
  issuedAt: string;
  expiresAt: string;
};

export type InstamartEligibility = {
  eligible: boolean;
  reason: 'eligible' | 'min_order_not_met' | 'over_limit' | 'no_payment_method' | 'disabled';
  fallback: 'instamart_app' | null;
};

export type InstamartOrder = {
  id: string;
  providerOrderId?: string | null;
  status?: string;
  localStatus?: string;
  providerStatus?: string | null;
  totalCents: number;
  placedAt?: string;
  createdAt?: string;
  trackingUrl?: string | null;
  tracking?: {
    trackingUrl: string | null;
    deliveryEta: string | null;
    storeName: string;
    storeCount: number;
  } | null;
};

export function formatRupees(paise: number): string {
  return new Intl.NumberFormat('en-IN', {
    style: 'currency',
    currency: 'INR',
    maximumFractionDigits: paise % 100 === 0 ? 0 : 2,
  }).format(paise / 100);
}

export function cartNeedName(item: InstamartCartNeed): string {
  return (item.freeTextItem ?? item.ingredientKey ?? 'Grocery item')
    .replaceAll('_', ' ')
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}
