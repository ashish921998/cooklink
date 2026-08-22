import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { swiggyTokens, type Database } from '@cooklink/db';
import {
  ProviderError,
  classifyCheckoutResult,
  type GroceryProvider,
  type ProviderAddress,
  type ProviderCartItem,
  type ProviderCartReview,
  type ProviderOrder,
  type ProviderOrderStatus,
  type ProviderPaymentMethod,
  type ProviderProduct,
  type UserId,
} from '@cooklink/domain';

const DEFAULT_BASE_URL = 'https://mcp.swiggy.com';
const OAUTH_PENDING_TTL_MS = 10 * 60_000;
const MCP_PROTOCOL_VERSION = '2025-03-26';
const READ_TIMEOUT_MS = 15_000;
const MUTATION_TIMEOUT_MS = 30_000;

type JsonRecord = Record<string, unknown>;

export interface StoredSwiggyToken {
  accessToken: string;
  expiresAt: Date;
}

export interface SwiggyTokenStore {
  get(userId: UserId): Promise<StoredSwiggyToken | null>;
  set(userId: UserId, token: StoredSwiggyToken): Promise<void>;
  delete(userId: UserId): Promise<void>;
}

interface PendingOAuth {
  userId: UserId;
  redirectUri: string;
  clientId: string;
  clientSecret: string | null;
  codeVerifier: string;
  createdAt: number;
}

export interface SwiggyProviderOptions {
  tokenStore: SwiggyTokenStore;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  now?: () => Date;
  clientName?: string;
}

/**
 * Persist Swiggy's five-day bearer token encrypted at rest with AES-256-GCM.
 * The encryption key is server-only and must decode to exactly 32 bytes.
 */
export function createDatabaseSwiggyTokenStore(
  db: Database,
  encryptionKey: string,
): SwiggyTokenStore {
  const key = decodeEncryptionKey(encryptionKey);
  return {
    async get(userId) {
      const [row] = await db
        .select()
        .from(swiggyTokens)
        .where(eq(swiggyTokens.userId, userId as string))
        .limit(1);
      if (!row) return null;
      if (row.expiresAt.getTime() <= Date.now()) {
        await db.delete(swiggyTokens).where(eq(swiggyTokens.userId, userId as string));
        return null;
      }
      try {
        return {
          accessToken: decryptToken(row.encryptedAccessToken, key),
          expiresAt: row.expiresAt,
        };
      } catch {
        // A rotated/missing key must fail closed as disconnected, never turn a
        // status check into a 500 or risk using corrupted credential bytes.
        await db.delete(swiggyTokens).where(eq(swiggyTokens.userId, userId as string));
        return null;
      }
    },
    async set(userId, token) {
      const encryptedAccessToken = encryptToken(token.accessToken, key);
      await db
        .insert(swiggyTokens)
        .values({
          userId: userId as string,
          encryptedAccessToken,
          encryptedRefreshToken: null,
          expiresAt: token.expiresAt,
          updatedAt: new Date(),
        })
        .onConflictDoUpdate({
          target: swiggyTokens.userId,
          set: { encryptedAccessToken, expiresAt: token.expiresAt, updatedAt: new Date() },
        });
    },
    async delete(userId) {
      await db.delete(swiggyTokens).where(eq(swiggyTokens.userId, userId as string));
    },
  };
}

export function createSwiggyProvider(options: SwiggyProviderOptions): GroceryProvider {
  const baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, '');
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? (() => new Date());
  const clientName = options.clientName ?? 'Cooklink';
  const pendingOAuth = new Map<string, PendingOAuth>();
  const recentProducts = new Map<string, Map<string, ProviderProduct>>();

  async function getToken(userId: UserId): Promise<StoredSwiggyToken> {
    const token = await options.tokenStore.get(userId);
    if (!token || token.expiresAt.getTime() <= now().getTime() + 60_000) {
      if (token) await options.tokenStore.delete(userId);
      throw new ProviderError('Swiggy session expired. Connect again.', 'expired_session', 401);
    }
    return token;
  }

  async function callTool<T>(
    userId: UserId,
    name: string,
    args: JsonRecord,
    mutation = false,
  ): Promise<T> {
    const token = await getToken(userId);
    const attempts = mutation ? 1 : 5;
    let delayMs = 500;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      let response: Response;
      try {
        response = await fetchImpl(`${baseUrl}/im`, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${token.accessToken}`,
            'content-type': 'application/json',
            accept: 'application/json, text/event-stream',
            'mcp-protocol-version': MCP_PROTOCOL_VERSION,
          },
          body: JSON.stringify({
            jsonrpc: '2.0',
            method: 'tools/call',
            params: { name, arguments: args },
            id: randomUUID(),
          }),
          signal: AbortSignal.timeout(mutation ? MUTATION_TIMEOUT_MS : READ_TIMEOUT_MS),
        });
      } catch (error) {
        if (attempt < attempts) {
          await pause(withJitter(delayMs));
          delayMs = Math.min(delayMs * 2, 8_000);
          continue;
        }
        throw new ProviderError(
          error instanceof Error ? error.message : 'Swiggy request failed',
          'upstream_error',
          502,
        );
      }

      if (response.status === 401 || response.status === 419) {
        await options.tokenStore.delete(userId);
        throw new ProviderError('Swiggy session expired. Connect again.', 'expired_session', 401);
      }
      if (response.status === 429) {
        if (attempt < attempts) {
          const retryAfter = Number(response.headers.get('retry-after'));
          await pause(Number.isFinite(retryAfter) ? retryAfter * 1_000 : withJitter(delayMs));
          delayMs = Math.min(delayMs * 2, 8_000);
          continue;
        }
        throw new ProviderError(
          'Swiggy rate limit reached. Try again shortly.',
          'rate_limited',
          429,
        );
      }
      if ([500, 502, 503, 504].includes(response.status) && attempt < attempts) {
        await pause(withJitter(delayMs));
        delayMs = Math.min(delayMs * 2, 8_000);
        continue;
      }
      if (!response.ok) {
        throw new ProviderError(
          `Swiggy MCP returned HTTP ${response.status}`,
          'upstream_error',
          502,
        );
      }

      const rpc = parseMcpResponse(await response.text());
      if (isRecord(rpc.error)) {
        const code = numberValue(rpc.error.code) ?? 0;
        const message = stringValue(rpc.error.message) ?? 'Swiggy MCP request failed';
        if (code === -32001) {
          await options.tokenStore.delete(userId);
          throw new ProviderError(message, 'expired_session', 401);
        }
        throw classifyProviderError(message);
      }
      const envelope = extractToolEnvelope(rpc.result);
      if (!envelope.success) throw classifyProviderError(envelope.message);
      return envelope.data as T;
    }
    throw new ProviderError('Swiggy request failed', 'upstream_error', 502);
  }

  async function paymentMethods(userId: UserId): Promise<ProviderPaymentMethod[]> {
    try {
      const data = await callTool<JsonRecord>(userId, 'get_payment_options', {});
      return normalizePaymentMethods(data);
    } catch (error) {
      if (error instanceof ProviderError && error.code !== 'expired_session') return [];
      throw error;
    }
  }

  return {
    async getConnectionStatus(userId) {
      const token = await options.tokenStore.get(userId);
      return token
        ? { connected: true, expiresAt: token.expiresAt.toISOString() }
        : { connected: false, expiresAt: null };
    },

    async startOAuth({ memberUserId, redirectUri }) {
      const registration = await registerClient(fetchImpl, baseUrl, clientName, redirectUri);
      const codeVerifier = randomBytes(32).toString('base64url');
      const codeChallenge = createHash('sha256').update(codeVerifier).digest('base64url');
      const state = randomUUID();
      pendingOAuth.set(state, {
        userId: memberUserId,
        redirectUri,
        clientId: registration.clientId,
        clientSecret: registration.clientSecret,
        codeVerifier,
        createdAt: now().getTime(),
      });
      const authorizationUrl = new URL(`${baseUrl}/auth/authorize`);
      authorizationUrl.search = new URLSearchParams({
        response_type: 'code',
        client_id: registration.clientId,
        redirect_uri: redirectUri,
        code_challenge: codeChallenge,
        code_challenge_method: 'S256',
        state,
        scope: 'mcp:tools',
      }).toString();
      return { authorizationUrl: authorizationUrl.toString(), state };
    },

    async completeOAuth({ memberUserId, code, state }) {
      const pending = pendingOAuth.get(state);
      pendingOAuth.delete(state);
      if (
        !pending ||
        pending.userId !== memberUserId ||
        now().getTime() - pending.createdAt > OAUTH_PENDING_TTL_MS
      ) {
        throw new ProviderError('Swiggy OAuth session expired', 'expired_session', 401);
      }
      const body: JsonRecord = {
        grant_type: 'authorization_code',
        code,
        code_verifier: pending.codeVerifier,
        redirect_uri: pending.redirectUri,
        client_id: pending.clientId,
      };
      if (pending.clientSecret) body.client_secret = pending.clientSecret;
      const response = await fetchImpl(`${baseUrl}/auth/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(READ_TIMEOUT_MS),
      });
      const payload = (await response.json().catch(() => null)) as unknown;
      if (!response.ok || !isRecord(payload)) {
        throw new ProviderError('Could not complete Swiggy OAuth', 'expired_session', 401);
      }
      const accessToken = stringValue(payload.access_token);
      const expiresIn = numberValue(payload.expires_in) ?? 432_000;
      if (!accessToken) {
        throw new ProviderError('Swiggy OAuth returned no access token', 'expired_session', 401);
      }
      await options.tokenStore.set(memberUserId, {
        accessToken,
        expiresAt: new Date(now().getTime() + expiresIn * 1_000),
      });
      return { connected: true };
    },

    async disconnect(userId) {
      const token = await options.tokenStore.get(userId);
      if (token) {
        await fetchImpl(`${baseUrl}/auth/logout`, {
          method: 'POST',
          headers: { authorization: `Bearer ${token.accessToken}` },
          signal: AbortSignal.timeout(READ_TIMEOUT_MS),
        }).catch(() => undefined);
      }
      await options.tokenStore.delete(userId);
      recentProducts.delete(userId as string);
    },

    async getAddresses(userId) {
      const addresses: ProviderAddress[] = [];
      for (let page = 1; page <= 10; page += 1) {
        const data = await callTool<JsonRecord>(userId, 'get_addresses', { page, pageSize: 10 });
        const rows = arrayValue(data.addresses).map(normalizeAddress).filter(isPresent);
        addresses.push(...rows);
        const pagination = recordValue(data.pagination);
        if (!pagination || pagination.hasMore !== true) break;
      }
      return [...new Map(addresses.map((address) => [address.id, address])).values()];
    },

    async searchProducts({ memberUserId, addressId, query }) {
      const data = await callTool<JsonRecord>(memberUserId, 'search_products', {
        addressId,
        query,
        offset: 0,
      });
      const direct = flattenProducts(arrayValue(data.products), addressId, false);
      const similar = flattenProducts(arrayValue(data.similarProducts), addressId, true);
      const products = [...direct, ...similar];
      const cache =
        recentProducts.get(memberUserId as string) ?? new Map<string, ProviderProduct>();
      for (const product of products) cache.set(product.id, product);
      recentProducts.set(memberUserId as string, cache);
      return products;
    },

    async getCart(userId, addressId) {
      const data = await callTool<JsonRecord>(userId, 'get_cart', {});
      const methods = await paymentMethods(userId);
      return normalizeCart(data, addressId, methods);
    },

    async updateCart({ memberUserId, addressId, items }) {
      await callTool<JsonRecord>(
        memberUserId,
        'update_cart',
        {
          selectedAddressId: addressId,
          items: items.map((item) => ({
            spinId: item.productId,
            ...(item.skuId ? { skuId: item.skuId } : {}),
            quantity: item.quantity,
          })),
        },
        true,
      );
      const review = await this.getCart(memberUserId, addressId);
      if (!review) throw new ProviderError('Cart is empty', 'cart_empty', 400);
      return review;
    },

    async clearCart(memberUserId) {
      await callTool<JsonRecord>(memberUserId, 'clear_cart', {}, true);
    },

    async getAlternatives({ memberUserId, addressId, productId }) {
      const cached = recentProducts.get(memberUserId as string)?.get(productId);
      if (!cached) return [];
      const products = await this.searchProducts({
        memberUserId,
        addressId,
        query: cached.name,
      });
      return products
        .filter((product) => product.available && product.id !== productId)
        .slice(0, 3);
    },

    async placeOrder({ memberUserId, addressId, paymentMethodId }) {
      const review = await this.getCart(memberUserId, addressId);
      if (!review) throw new ProviderError('Cart is empty', 'cart_empty', 400);
      const selected = review.availablePaymentMethods.find(
        (method) => method.id === paymentMethodId,
      );
      if (!selected) {
        throw new ProviderError(
          'Payment method is not available',
          'payment_method_unavailable',
          400,
        );
      }
      const paymentMethod = selected.kind.toUpperCase() === 'UPI' ? 'UPI' : 'Cash';
      const checkoutArgs: JsonRecord = { addressId, paymentMethod };
      if (paymentMethod === 'UPI') checkoutArgs.intentApp = selected.id;
      const data = await callTool<JsonRecord>(memberUserId, 'checkout', checkoutArgs, true);
      const status = stringValue(data.status) ?? 'placed';
      if (status.toUpperCase() === 'PENDING_PAYMENT') {
        throw new ProviderError(
          'UPI payment is pending. Finish payment in Swiggy before retrying.',
          'upstream_error',
          502,
        );
      }
      const returnedOrders = arrayValue(data.orders).map(normalizeOrder).filter(isPresent);
      if (returnedOrders.length > 0) {
        const classified = classifyCheckoutResult(returnedOrders);
        return { orders: returnedOrders, ...classified };
      }
      if (review.storeCount > 1) {
        throw new ProviderError(
          'Swiggy did not return per-store order results for this multi-store cart.',
          'product_unavailable',
          400,
        );
      }
      const order = normalizeCheckoutOrder(data, review, now());
      const classified = classifyCheckoutResult([order]);
      return { orders: [order], ...classified };
    },

    async getOrders(userId) {
      const data = await callTool<JsonRecord>(userId, 'get_orders', {
        count: 20,
        orderType: 'DASH',
        activeOnly: false,
      });
      return arrayValue(data.orders ?? data.orderHistory)
        .map(normalizeOrder)
        .filter(isPresent);
    },
  };
}

async function registerClient(
  fetchImpl: typeof fetch,
  baseUrl: string,
  clientName: string,
  redirectUri: string,
): Promise<{ clientId: string; clientSecret: string | null }> {
  const response = await fetchImpl(`${baseUrl}/auth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({
      client_name: clientName,
      redirect_uris: [redirectUri],
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code'],
      response_types: ['code'],
      scope: 'mcp:tools',
    }),
    signal: AbortSignal.timeout(READ_TIMEOUT_MS),
  });
  const payload = (await response.json().catch(() => null)) as unknown;
  if (!response.ok || !isRecord(payload) || !stringValue(payload.client_id)) {
    throw new ProviderError('Could not register Cooklink with Swiggy OAuth', 'upstream_error', 502);
  }
  return {
    clientId: stringValue(payload.client_id)!,
    clientSecret: stringValue(payload.client_secret),
  };
}

function parseMcpResponse(raw: string): JsonRecord {
  const trimmed = raw.trim();
  if (trimmed.startsWith('{')) {
    const parsed = JSON.parse(trimmed) as unknown;
    if (isRecord(parsed)) return parsed;
  }
  const dataLines = trimmed
    .split(/\r?\n/)
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trim());
  for (const line of dataLines.reverse()) {
    if (!line || line === '[DONE]') continue;
    const parsed = JSON.parse(line) as unknown;
    if (isRecord(parsed)) return parsed;
  }
  throw new ProviderError('Swiggy MCP returned an unreadable response', 'upstream_error', 502);
}

function extractToolEnvelope(result: unknown): {
  success: boolean;
  data: unknown;
  message: string;
} {
  const record = recordValue(result) ?? {};
  const structured = recordValue(record.structuredContent);
  if (structured) return normalizeEnvelope(structured);
  for (const block of arrayValue(record.content)) {
    const content = recordValue(block);
    const text = content ? stringValue(content.text) : null;
    if (!text) continue;
    try {
      const parsed = JSON.parse(text) as unknown;
      if (isRecord(parsed)) return normalizeEnvelope(parsed);
    } catch {
      if (record.isError === true) return { success: false, data: null, message: text };
    }
  }
  if (record.isError === true) return { success: false, data: null, message: 'Swiggy tool failed' };
  return normalizeEnvelope(record);
}

function normalizeEnvelope(record: JsonRecord): {
  success: boolean;
  data: unknown;
  message: string;
} {
  const error = recordValue(record.error);
  const message =
    stringValue(error?.message) ?? stringValue(record.message) ?? 'Swiggy tool request failed';
  return {
    success: record.success !== false && !error,
    data: record.data ?? record,
    message,
  };
}

function normalizeAddress(value: unknown): ProviderAddress | null {
  const row = recordValue(value);
  if (!row) return null;
  const id = firstString(row, 'addressId', 'id');
  if (!id) return null;
  const full =
    firstString(row, 'address', 'formattedAddress', 'displayAddress', 'addressLine') ?? '';
  return {
    id,
    label:
      firstString(row, 'label', 'annotation', 'type', 'name', 'addressTag', 'addressCategory') ??
      'Saved address',
    line1: firstString(row, 'line1', 'addressLine1', 'flatNo', 'doorNo') ?? full,
    line2: firstString(row, 'line2', 'addressLine2', 'landmark'),
    city: firstString(row, 'city', 'locality', 'area') ?? '',
    pincode: firstString(row, 'pincode', 'postalCode', 'zipCode') ?? '',
    lat: numberValue(row.lat ?? row.latitude),
    lng: numberValue(row.lng ?? row.longitude),
  };
}

function flattenProducts(rows: unknown[], addressId: string, similar: boolean): ProviderProduct[] {
  const products: ProviderProduct[] = [];
  for (const value of rows) {
    const parent = recordValue(value);
    if (!parent) continue;
    const variations = arrayValue(parent.variations ?? parent.variants);
    const candidates = variations.length > 0 ? variations : [parent];
    for (const variationValue of candidates) {
      const variation = recordValue(variationValue);
      if (!variation) continue;
      const id = firstString(variation, 'spinId', 'productId', 'id');
      if (!id) continue;
      const nestedPrice = recordValue(variation.price);
      const priceCents = nestedPrice
        ? moneyValue(nestedPrice, ['offerPriceCents'], ['offerPrice', 'unitLevelPrice', 'mrp'])
        : moneyValue(
            variation,
            ['priceCents', 'finalPriceCents'],
            ['price', 'finalPrice', 'sellingPrice'],
          );
      const mrpCents = nestedPrice
        ? moneyValue(nestedPrice, ['mrpCents'], ['mrp'])
        : moneyValue(variation, ['mrpCents'], ['mrp', 'originalPrice']);
      products.push({
        id,
        skuId: firstString(variation, 'skuId', 'sku_id'),
        name:
          firstString(parent, 'name', 'title', 'displayName') ??
          firstString(variation, 'displayName', 'name') ??
          'Instamart item',
        brand:
          firstString(parent, 'brand', 'brandName') ??
          firstString(variation, 'brandName', 'brand') ??
          'Instamart',
        variant: firstString(variation, 'variant', 'variantName'),
        packSize:
          firstString(variation, 'quantityDescription', 'packSize', 'quantity', 'displayName') ??
          '1 unit',
        priceCents,
        mrpCents: mrpCents || priceCents,
        available: booleanValue(
          variation.isInStockAndAvailable ??
            variation.available ??
            variation.inStock ??
            parent.isAvail ??
            parent.inStock ??
            parent.available,
          true,
        ),
        addressId,
        storeId: firstString(variation, 'storeId') ?? firstString(parent, 'storeId') ?? 'instamart',
        storeName:
          firstString(variation, 'storeName') ?? firstString(parent, 'storeName') ?? 'Instamart',
        imageUrl:
          firstString(variation, 'imageUrl', 'image') ?? firstString(parent, 'imageUrl', 'image'),
        similar,
      });
    }
  }
  return products;
}

function normalizeCart(
  value: JsonRecord,
  addressId: string,
  methods: ProviderPaymentMethod[],
): ProviderCartReview | null {
  const cart = recordValue(value.cart) ?? value;
  const rawItems = arrayValue(cart.items ?? cart.cartItems);
  if (rawItems.length === 0) return null;
  const items = rawItems.map(normalizeCartItem).filter(isPresent);
  if (items.length === 0) return null;
  const billRecord = recordValue(cart.billBreakdown);
  const rawBill = arrayValue(cart.billBreakdown ?? cart.bill ?? cart.charges);
  if (rawBill.length === 0 && billRecord) {
    rawBill.push(...arrayValue(billRecord.lineItems));
    if (recordValue(billRecord.toPay)) rawBill.push(billRecord.toPay);
  }
  const bill = rawBill
    .map((entry) => {
      const row = recordValue(entry);
      if (!row) return null;
      const label = firstString(row, 'label', 'name', 'title');
      if (!label) return null;
      return { label, amountCents: moneyValue(row, ['amountCents'], ['amount', 'value']) };
    })
    .filter(isPresent);
  const itemTotal = items.reduce((sum, item) => sum + item.lineTotalCents, 0);
  const totalCents =
    moneyValue(
      cart,
      ['totalCents'],
      ['cartTotal', 'cartTotalAmount', 'total', 'orderTotal', 'payableAmount'],
    ) ||
    bill.at(-1)?.amountCents ||
    itemTotal;
  if (bill.length === 0) bill.push({ label: 'Total', amountCents: totalCents });
  const cartMethods = normalizePaymentMethods({
    allMethods: arrayValue(cart.availablePaymentMethods),
  });
  return {
    addressId: firstString(cart, 'addressId', 'selectedAddressId') ?? addressId,
    items,
    bill,
    totalCents,
    availablePaymentMethods: mergePaymentMethods(methods, cartMethods),
    storeCount: new Set(items.map((item) => item.storeId)).size || 1,
    hasUnavailableItems: items.some((item) => !item.available),
  };
}

function normalizeCartItem(value: unknown): ProviderCartItem | null {
  const row = recordValue(value);
  if (!row) return null;
  const productId = firstString(row, 'spinId', 'productId', 'id');
  if (!productId) return null;
  const quantity = numberValue(row.quantity) ?? 1;
  const priceCents = moneyValue(
    row,
    ['priceCents'],
    ['discountedFinalPrice', 'price', 'unitPrice', 'mrp'],
  );
  return {
    productId,
    skuId: firstString(row, 'skuId', 'sku_id'),
    name: firstString(row, 'name', 'title', 'itemName') ?? 'Instamart item',
    brand: firstString(row, 'brand', 'brandName') ?? 'Instamart',
    variant: firstString(row, 'variant', 'variantName', 'itemVariant'),
    packSize:
      firstString(row, 'quantityDescription', 'packSize', 'displayQuantity', 'itemVariant') ??
      '1 unit',
    quantity,
    priceCents,
    lineTotalCents:
      moneyValue(row, ['lineTotalCents'], ['lineTotal', 'totalPrice']) || priceCents * quantity,
    available: booleanValue(row.isInStockAndAvailable ?? row.available ?? row.inStock, true),
    storeId: firstString(row, 'storeId') ?? 'instamart',
    storeName: firstString(row, 'storeName') ?? 'Instamart',
  };
}

function normalizePaymentMethods(value: JsonRecord): ProviderPaymentMethod[] {
  const methods = arrayValue(value.allMethods);
  const cod = recordValue(value.cod);
  if (cod) methods.push(cod);
  const seen = new Set<string>();
  const normalized: ProviderPaymentMethod[] = [];
  for (const methodValue of methods) {
    const method = recordValue(methodValue);
    if (!method) continue;
    const id = firstString(method, 'id', 'paymentMethod', 'value');
    if (!id || seen.has(id)) continue;
    const label = firstString(method, 'label', 'name') ?? id;
    // The canonical grocery recipe uses Cash/COD. UPI requires a separate
    // pending-payment polling and confirmation journey, so V1 safely hands
    // carts without Cash back to the Instamart app instead of initiating a
    // payment that Cooklink cannot yet reconcile.
    if (!/cash|cod/i.test(`${id} ${label}`)) continue;
    const kind = 'COD';
    seen.add(id);
    normalized.push({ id, label, kind });
  }
  return normalized;
}

function mergePaymentMethods(
  primary: ProviderPaymentMethod[],
  secondary: ProviderPaymentMethod[],
): ProviderPaymentMethod[] {
  const methods = new Map(primary.map((method) => [method.id, method]));
  for (const method of secondary) methods.set(method.id, method);
  return [...methods.values()];
}

function normalizeCheckoutOrder(
  value: JsonRecord,
  review: ProviderCartReview,
  placedAt: Date,
): ProviderOrder {
  const id = firstString(value, 'orderId', 'id') ?? `swiggy-${randomUUID()}`;
  return {
    id,
    status: normalizeOrderStatus(firstString(value, 'status')),
    storeId: review.items[0]?.storeId ?? 'instamart',
    storeName: review.items[0]?.storeName ?? 'Instamart',
    totalCents: moneyValue(value, ['totalCents'], ['cartTotal', 'total']) || review.totalCents,
    items: review.items.map((item) => ({
      productId: item.productId,
      name: item.name,
      quantity: item.quantity,
      lineTotalCents: item.lineTotalCents,
      storeId: item.storeId,
      storeName: item.storeName,
    })),
    placedAt: placedAt.toISOString(),
    deliveryEta: null,
    trackingUrl: null,
    cancellableUntil: null,
    cancellationPolicy: 'For cancellation, call Swiggy customer care at 080-67466729.',
  };
}

function normalizeOrder(value: unknown): ProviderOrder | null {
  const row = recordValue(value);
  if (!row) return null;
  const id = firstString(row, 'orderId', 'id');
  if (!id) return null;
  const items = arrayValue(row.items).map((itemValue) => {
    const item = recordValue(itemValue) ?? {};
    return {
      productId: firstString(item, 'spinId', 'productId', 'id') ?? 'unknown',
      name: firstString(item, 'name', 'title') ?? 'Instamart item',
      quantity: numberValue(item.quantity) ?? 1,
      lineTotalCents: moneyValue(item, ['lineTotalCents'], ['lineTotal', 'totalPrice']),
      storeId: firstString(item, 'storeId') ?? firstString(row, 'storeId') ?? 'instamart',
      storeName: firstString(item, 'storeName') ?? firstString(row, 'storeName') ?? 'Instamart',
    };
  });
  return {
    id,
    status: normalizeOrderStatus(firstString(row, 'status', 'orderStatus')),
    storeId: firstString(row, 'storeId') ?? 'instamart',
    storeName: firstString(row, 'storeName') ?? 'Instamart',
    totalCents: moneyValue(row, ['totalCents'], ['total', 'orderTotal', 'cartTotal']),
    items,
    placedAt: firstString(row, 'placedAt', 'createdAt', 'orderTime') ?? new Date(0).toISOString(),
    deliveryEta: firstString(row, 'deliveryEta', 'eta'),
    trackingUrl: firstString(row, 'trackingUrl'),
    cancellableUntil: firstString(row, 'cancellableUntil'),
    cancellationPolicy: 'For cancellation, call Swiggy customer care at 080-67466729.',
  };
}

function normalizeOrderStatus(value: string | null): ProviderOrderStatus {
  const status = (value ?? 'placed').toLowerCase().replaceAll(' ', '_');
  if (status.includes('deliver') && !status.includes('out')) return 'delivered';
  if (status.includes('out_for') || status.includes('on_the_way')) return 'out_for_delivery';
  if (status.includes('cancel')) return 'cancelled';
  if (status.includes('fail')) return 'failed';
  if (status.includes('confirm')) return 'confirmed';
  return 'placed';
}

function classifyProviderError(message: string): ProviderError {
  const lower = message.toLowerCase();
  if (lower.includes('not authenticated') || lower.includes('session') || lower.includes('token')) {
    return new ProviderError(message, 'expired_session', 401);
  }
  if (lower.includes('rate limit')) return new ProviderError(message, 'rate_limited', 429);
  if (lower.includes('address') && lower.includes('not')) {
    return new ProviderError(message, 'address_not_found', 404);
  }
  if (lower.includes('out of stock') || lower.includes('unavailable')) {
    return new ProviderError(message, 'product_unavailable', 400);
  }
  if (lower.includes('product') && lower.includes('not')) {
    return new ProviderError(message, 'product_not_found', 404);
  }
  if (lower.includes('cart') && lower.includes('empty')) {
    return new ProviderError(message, 'cart_empty', 400);
  }
  return new ProviderError(message, 'upstream_error', 502);
}

function decodeEncryptionKey(value: string): Buffer {
  const key = Buffer.from(value, 'base64');
  if (key.length !== 32) {
    throw new Error('SWIGGY_TOKEN_ENCRYPTION_KEY must be a base64-encoded 32-byte key.');
  }
  return key;
}

function encryptToken(value: string, key: Buffer): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return [
    'v1',
    iv.toString('base64url'),
    cipher.getAuthTag().toString('base64url'),
    encrypted.toString('base64url'),
  ].join('.');
}

function decryptToken(value: string, key: Buffer): string {
  const [version, ivValue, tagValue, encryptedValue] = value.split('.');
  if (version !== 'v1' || !ivValue || !tagValue || !encryptedValue) {
    throw new Error('Stored Swiggy token has an unsupported encryption envelope.');
  }
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(ivValue, 'base64url'));
  decipher.setAuthTag(Buffer.from(tagValue, 'base64url'));
  return Buffer.concat([
    decipher.update(Buffer.from(encryptedValue, 'base64url')),
    decipher.final(),
  ]).toString('utf8');
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function recordValue(value: unknown): JsonRecord | null {
  return isRecord(value) ? value : null;
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? [...value] : [];
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

function numberValue(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const number = Number(value.replace(/[^0-9.-]/g, ''));
    return Number.isFinite(number) ? number : null;
  }
  return null;
}

function booleanValue(value: unknown, fallback: boolean): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value > 0;
  if (typeof value === 'string')
    return !['false', '0', 'out_of_stock'].includes(value.toLowerCase());
  return fallback;
}

function firstString(record: JsonRecord, ...keys: string[]): string | null {
  for (const key of keys) {
    const value = stringValue(record[key]);
    if (value) return value;
  }
  return null;
}

function moneyValue(record: JsonRecord, paiseKeys: string[], rupeeKeys: string[]): number {
  for (const key of paiseKeys) {
    const value = numberValue(record[key]);
    if (value !== null) return Math.round(value);
  }
  for (const key of rupeeKeys) {
    const value = numberValue(record[key]);
    if (value !== null) return Math.round(value * 100);
  }
  return 0;
}

function isPresent<T>(value: T | null): value is T {
  return value !== null;
}

function withJitter(value: number): number {
  return Math.round(value * (0.75 + Math.random() * 0.5));
}

function pause(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
