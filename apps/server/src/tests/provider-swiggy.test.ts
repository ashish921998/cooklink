import assert from 'node:assert/strict';
import test from 'node:test';
import { brandId } from '@cooklink/domain';
import {
  createSwiggyProvider,
  type StoredSwiggyToken,
  type SwiggyTokenStore,
} from '../provider-swiggy.js';

const USER = brandId<'UserId'>('u-swiggy-live-test');

function createMemoryTokenStore(): SwiggyTokenStore {
  const tokens = new Map<string, StoredSwiggyToken>();
  return {
    async get(userId) {
      return tokens.get(userId as string) ?? null;
    },
    async set(userId, token) {
      tokens.set(userId as string, token);
    },
    async delete(userId) {
      tokens.delete(userId as string);
    },
  };
}

function rpc(data: unknown): Response {
  return Response.json({
    jsonrpc: '2.0',
    id: 'rpc-1',
    result: {
      content: [{ type: 'text', text: JSON.stringify({ success: true, data }) }],
    },
  });
}

test('real provider completes PKCE OAuth and maps the Instamart journey', async () => {
  const calls: { url: string; body: Record<string, unknown> }[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    calls.push({ url, body });
    if (url.endsWith('/auth/register')) {
      return Response.json({ client_id: 'cooklink-dcr-client' });
    }
    if (url.endsWith('/auth/token')) {
      return Response.json({ access_token: 'test-access-token', expires_in: 432_000 });
    }
    if (url.endsWith('/auth/logout')) return new Response(null, { status: 204 });

    const params = body.params as
      { name?: string; arguments?: Record<string, unknown> } | undefined;
    switch (params?.name) {
      case 'get_addresses':
        return rpc({
          addresses: [
            {
              addressId: 'addr-home',
              annotation: 'Home',
              addressLine1: '12 Brigade Road',
              city: 'Bengaluru',
              pincode: '560025',
            },
          ],
          pagination: { hasMore: false },
        });
      case 'search_products':
        return rpc({
          products: [
            {
              name: 'Tomato',
              brand: 'Fresh Farms',
              storeId: 'store-1',
              storeName: 'Instamart Brigade',
              variations: [
                {
                  spinId: 'spin-tomato',
                  skuId: 'sku-tomato',
                  quantityDescription: '500 g',
                  price: { offerPrice: 30, mrp: 35, unitLevelPrice: 30 },
                  isInStockAndAvailable: true,
                },
              ],
            },
          ],
          similarProducts: [
            {
              name: 'Cherry Tomato',
              brand: 'Fresh Farms',
              variations: [
                {
                  spinId: 'spin-cherry',
                  skuId: 'sku-cherry',
                  quantityDescription: '250 g',
                  price: { offerPrice: 45, mrp: 50, unitLevelPrice: 45 },
                  isInStockAndAvailable: true,
                },
              ],
            },
          ],
        });
      case 'update_cart':
        return rpc({ updated: true });
      case 'clear_cart':
        return rpc({ cleared: true });
      case 'get_cart':
        return rpc({
          addressId: 'addr-home',
          items: [
            {
              spinId: 'spin-tomato',
              skuId: 'sku-tomato',
              itemName: 'Tomato',
              itemVariant: '500 g',
              quantity: 3,
              discountedFinalPrice: 30,
              mrp: 35,
              isInStockAndAvailable: true,
              storeId: 'store-1',
            },
          ],
          billBreakdown: {
            lineItems: [
              { label: 'Item total', value: 90 },
              { label: 'Delivery fee', value: 25 },
            ],
            toPay: { label: 'Total', value: 115 },
          },
          cartTotalAmount: 115,
        });
      case 'get_payment_options':
        return rpc({
          allMethods: [{ id: 'Cash', label: 'Cash on Delivery' }],
          cod: { paymentMethod: 'Cash', label: 'Cash on Delivery' },
        });
      case 'checkout':
        return rpc({ orderId: 'order-1', status: 'PLACED', paymentMethod: 'Cash', cartTotal: 115 });
      case 'get_orders':
        return rpc({
          orders: [
            {
              orderId: 'order-1',
              status: 'OUT_FOR_DELIVERY',
              orderTotal: 115,
              createdAt: '2026-08-21T10:00:00.000Z',
              storeName: 'Instamart Brigade',
              items: [],
            },
          ],
        });
      default:
        return Response.json(
          { error: `Unexpected tool ${params?.name ?? 'none'}` },
          { status: 500 },
        );
    }
  };

  const provider = createSwiggyProvider({ tokenStore: createMemoryTokenStore(), fetchImpl });
  const started = await provider.startOAuth({
    memberUserId: USER,
    redirectUri: 'cooklink://swiggy-callback',
  });
  const authorizationUrl = new URL(started.authorizationUrl);
  assert.equal(authorizationUrl.pathname, '/auth/authorize');
  assert.equal(authorizationUrl.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(authorizationUrl.searchParams.get('state'), started.state);

  await provider.completeOAuth({ memberUserId: USER, code: 'oauth-code', state: started.state });
  assert.equal((await provider.getConnectionStatus(USER)).connected, true);

  const addresses = await provider.getAddresses(USER);
  assert.equal(addresses[0]?.id, 'addr-home');
  assert.equal(addresses[0]?.lat, null);

  const products = await provider.searchProducts({
    memberUserId: USER,
    addressId: 'addr-home',
    query: 'tomato',
  });
  assert.equal(products.length, 2);
  assert.equal(products[0]?.id, 'spin-tomato');
  assert.equal(products[0]?.skuId, 'sku-tomato');
  assert.equal(products[0]?.priceCents, 3000);
  assert.equal(products[1]?.similar, true);

  const review = await provider.updateCart({
    memberUserId: USER,
    addressId: 'addr-home',
    items: [{ productId: 'spin-tomato', skuId: 'sku-tomato', quantity: 3 }],
  });
  assert.equal(review.totalCents, 11_500);
  assert.equal(review.availablePaymentMethods[0]?.id, 'Cash');
  const updateCall = calls.find(
    (call) => (call.body.params as { name?: string } | undefined)?.name === 'update_cart',
  );
  assert.deepEqual(
    (updateCall?.body.params as { arguments?: Record<string, unknown> } | undefined)?.arguments,
    {
      selectedAddressId: 'addr-home',
      items: [{ spinId: 'spin-tomato', skuId: 'sku-tomato', quantity: 3 }],
    },
  );

  const checkout = await provider.placeOrder({
    memberUserId: USER,
    addressId: 'addr-home',
    paymentMethodId: 'Cash',
    idempotencyKey: 'server-owned-key',
  });
  assert.equal(checkout.orders[0]?.id, 'order-1');
  assert.equal(checkout.allSucceeded, true);

  await provider.clearCart(USER, 'addr-home');
  assert.ok(
    calls.some(
      (call) => (call.body.params as { name?: string } | undefined)?.name === 'clear_cart',
    ),
  );

  const orders = await provider.getOrders(USER);
  assert.equal(orders[0]?.status, 'out_for_delivery');

  await provider.disconnect(USER);
  assert.equal((await provider.getConnectionStatus(USER)).connected, false);
});

test('real provider rejects an OAuth callback with the wrong member', async () => {
  const fetchImpl: typeof fetch = async (input) => {
    if (String(input).endsWith('/auth/register')) {
      return Response.json({ client_id: 'cooklink-dcr-client' });
    }
    throw new Error('Token exchange must not run');
  };
  const provider = createSwiggyProvider({ tokenStore: createMemoryTokenStore(), fetchImpl });
  const started = await provider.startOAuth({
    memberUserId: USER,
    redirectUri: 'cooklink://swiggy-callback',
  });
  await assert.rejects(
    () =>
      provider.completeOAuth({
        memberUserId: brandId<'UserId'>('different-user'),
        code: 'oauth-code',
        state: started.state,
      }),
    /expired/i,
  );
});
