import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Linking, StyleSheet, View } from 'react-native';
import * as ExpoLinking from 'expo-linking';
import * as WebBrowser from 'expo-web-browser';
import { useApi, ApiError } from '../lib/api';
import {
  cartNeedName,
  formatRupees,
  type InstamartAddress,
  type InstamartCartReview,
  type InstamartCheckoutConfirmation,
  type InstamartEligibility,
  type InstamartMatchResolution,
  type InstamartOrder,
  type InstamartPaymentMethod,
  type InstamartProduct,
} from '../lib/instamart';
import {
  Chip,
  ErrorNote,
  PotLoader,
  PressableScale,
  colors,
  fonts,
  radius,
  shadow,
  space,
  styles,
} from './ui';
import { Text } from './Typography';

const SELECTED_ACCESSIBILITY_STATE = { selected: true } as const;
const UNSELECTED_ACCESSIBILITY_STATE = { selected: false } as const;
const INSTAMART_APP_URL = 'https://www.swiggy.com/instamart';

type CartMode = 'preserve' | 'replace';

export function InstamartOrderFlow({ householdId }: { householdId: string }) {
  const api = useApi();
  const [connected, setConnected] = useState<boolean | null>(null);
  const [addresses, setAddresses] = useState<InstamartAddress[]>([]);
  const [selectedAddressId, setSelectedAddressId] = useState<string | null>(null);
  const [plan, setPlan] = useState<InstamartMatchResolution[] | null>(null);
  const [review, setReview] = useState<InstamartCartReview | null>(null);
  const [orders, setOrders] = useState<InstamartOrder[]>([]);
  const [cartMode, setCartMode] = useState<CartMode | null>(null);
  const [paymentMethodId, setPaymentMethodId] = useState<string | null>(null);
  const [confirmation, setConfirmation] = useState<InstamartCheckoutConfirmation | null>(null);
  const [eligibility, setEligibility] = useState<InstamartEligibility | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [placedMessage, setPlacedMessage] = useState<string | null>(null);
  const [addressLoadFailed, setAddressLoadFailed] = useState(false);
  const addressRequest = useRef(0);

  const providerPath = useCallback(
    (suffix: string) => `/v1/households/${householdId}/grocery-provider${suffix}`,
    [householdId],
  );

  const loadOrders = useCallback(async () => {
    const result = await api<{ orders: InstamartOrder[] }>(providerPath('/orders'));
    setOrders(result.orders);
  }, [api, providerPath]);

  const loadAddressData = useCallback(
    async (addressId: string) => {
      const request = ++addressRequest.current;
      const encoded = encodeURIComponent(addressId);
      let planResult: { plan: InstamartMatchResolution[]; allResolved: boolean };
      let cartResult: { review: InstamartCartReview | null };
      try {
        [planResult, cartResult] = await Promise.all([
          api<{ plan: InstamartMatchResolution[]; allResolved: boolean }>(
            providerPath(`/match-plan?addressId=${encoded}`),
          ),
          api<{ review: InstamartCartReview | null }>(providerPath(`/cart?addressId=${encoded}`)),
        ]);
      } catch (loadError) {
        if (request !== addressRequest.current) return;
        throw loadError;
      }
      if (request !== addressRequest.current) return;
      setPlan(planResult.plan);
      setReview(cartResult.review);
      setPaymentMethodId((current) =>
        cartResult.review?.availablePaymentMethods.some((method) => method.id === current)
          ? current
          : (cartResult.review?.availablePaymentMethods[0]?.id ?? null),
      );
      setConfirmation(null);
      setEligibility(null);
      setAddressLoadFailed(false);
    },
    [api, providerPath],
  );

  const loadConnection = useCallback(async () => {
    setError(null);
    try {
      const status = await api<{ connected: boolean }>(providerPath('/status'));
      setConnected(status.connected);
      if (!status.connected) {
        setAddresses([]);
        setSelectedAddressId(null);
        setPlan(null);
        setReview(null);
        setOrders([]);
        return;
      }
      const [addressResult] = await Promise.all([
        api<{ addresses: InstamartAddress[] }>(providerPath('/addresses')),
        loadOrders(),
      ]);
      setAddresses(addressResult.addresses);
      setSelectedAddressId((current) =>
        addressResult.addresses.some((address) => address.id === current)
          ? current
          : (addressResult.addresses[0]?.id ?? null),
      );
    } catch (loadError) {
      setConnected(false);
      setError(errorMessage(loadError, 'Could not load your Swiggy connection.'));
    }
  }, [api, loadOrders, providerPath]);

  useEffect(() => {
    void loadConnection();
  }, [loadConnection]);

  useEffect(() => {
    if (!connected || !selectedAddressId) return;
    setPlan(null);
    setAddressLoadFailed(false);
    void loadAddressData(selectedAddressId).catch((loadError) => {
      setPlan([]);
      setAddressLoadFailed(true);
      setError(errorMessage(loadError, 'Could not load Instamart products.'));
    });
  }, [connected, loadAddressData, selectedAddressId]);

  const connect = useCallback(async () => {
    setBusy('connect');
    setError(null);
    try {
      const appReturnUri = ExpoLinking.createURL('swiggy-callback');
      const start = await api<{ authorizationUrl: string; state: string }>(
        providerPath('/connect'),
        { method: 'POST', body: JSON.stringify({ appReturnUri }) },
      );
      const browserResult = await WebBrowser.openAuthSessionAsync(
        start.authorizationUrl,
        appReturnUri,
      );
      if (browserResult.type !== 'success') {
        throw new Error('Swiggy sign-in was cancelled.');
      }
      const callback = new URL(browserResult.url);
      const oauthError = callback.searchParams.get('error');
      if (oauthError) throw new Error(`Swiggy sign-in failed: ${oauthError}`);
      if (callback.searchParams.get('connected') !== '1') {
        throw new Error('Swiggy returned an invalid sign-in response.');
      }
      await loadConnection();
    } catch (connectError) {
      setError(errorMessage(connectError, 'Could not connect Swiggy.'));
    } finally {
      setBusy(null);
    }
  }, [api, loadConnection, providerPath]);

  const disconnect = useCallback(async () => {
    setBusy('disconnect');
    setError(null);
    try {
      await api(providerPath('/disconnect'), { method: 'POST' });
      await loadConnection();
    } catch (disconnectError) {
      setError(errorMessage(disconnectError, 'Could not disconnect Swiggy.'));
    } finally {
      setBusy(null);
    }
  }, [api, loadConnection, providerPath]);

  const selectAddress = useCallback((addressId: string) => {
    ++addressRequest.current;
    setSelectedAddressId(addressId);
    setReview(null);
    setConfirmation(null);
    setEligibility(null);
    setAddressLoadFailed(false);
  }, []);

  const retryAddressLoad = useCallback(() => {
    if (!selectedAddressId) return;
    setPlan(null);
    setAddressLoadFailed(false);
    setError(null);
    void loadAddressData(selectedAddressId).catch((loadError) => {
      setPlan([]);
      setAddressLoadFailed(true);
      setError(errorMessage(loadError, 'Could not load Instamart products.'));
    });
  }, [loadAddressData, selectedAddressId]);

  const chooseProduct = useCallback(
    async (cartItemId: string, product: InstamartProduct) => {
      if (!selectedAddressId) return;
      setBusy(cartItemId);
      setError(null);
      try {
        await api(providerPath('/match'), {
          method: 'POST',
          body: JSON.stringify({
            cartItemId,
            productId: product.id,
            addressId: selectedAddressId,
            quantity: 1,
          }),
        });
        await loadAddressData(selectedAddressId);
      } catch (matchError) {
        setError(errorMessage(matchError, 'Could not select that product.'));
      } finally {
        setBusy(null);
      }
    },
    [api, loadAddressData, providerPath, selectedAddressId],
  );

  const clearProduct = useCallback(
    async (cartItemId: string) => {
      if (!selectedAddressId) return;
      setBusy(cartItemId);
      setError(null);
      try {
        await api(providerPath(`/match/${cartItemId}`), { method: 'DELETE' });
        await loadAddressData(selectedAddressId);
      } catch (clearError) {
        setError(errorMessage(clearError, 'Could not change that product.'));
      } finally {
        setBusy(null);
      }
    },
    [api, loadAddressData, providerPath, selectedAddressId],
  );

  const preserveCart = useCallback(() => setCartMode('preserve'), []);
  const replaceCart = useCallback(() => setCartMode('replace'), []);

  const buildCart = useCallback(async () => {
    if (!selectedAddressId || !cartMode) return;
    setBusy('build-cart');
    setError(null);
    try {
      const result = await api<{ review: InstamartCartReview }>(providerPath('/cart/build'), {
        method: 'POST',
        body: JSON.stringify({ addressId: selectedAddressId, mode: cartMode }),
      });
      setReview(result.review);
      setPaymentMethodId(result.review.availablePaymentMethods[0]?.id ?? null);
      setConfirmation(null);
      setEligibility(null);
    } catch (buildError) {
      setError(errorMessage(buildError, 'Could not build your Instamart cart.'));
    } finally {
      setBusy(null);
    }
  }, [api, cartMode, providerPath, selectedAddressId]);

  const selectPayment = useCallback((methodId: string) => {
    setPaymentMethodId(methodId);
    setConfirmation(null);
    setEligibility(null);
  }, []);

  const prepareConfirmation = useCallback(async () => {
    if (!selectedAddressId || !paymentMethodId) return;
    setBusy('prepare-checkout');
    setError(null);
    try {
      const result = await api<{
        confirmation: InstamartCheckoutConfirmation;
        eligibility: InstamartEligibility;
        orderingEnabled: boolean;
      }>(providerPath('/checkout/confirm'), {
        method: 'POST',
        body: JSON.stringify({ addressId: selectedAddressId, paymentMethodId }),
      });
      setConfirmation(result.confirmation);
      setEligibility(result.eligibility);
    } catch (confirmError) {
      setError(errorMessage(confirmError, 'Could not prepare checkout.'));
    } finally {
      setBusy(null);
    }
  }, [api, paymentMethodId, providerPath, selectedAddressId]);

  const placeOrder = useCallback(async () => {
    if (!confirmation) return;
    setBusy('place-order');
    setError(null);
    try {
      const result = await api<{
        result: string;
        orders?: { id: string; status: string }[];
        deepLink?: string | null;
      }>(providerPath('/checkout'), {
        method: 'POST',
        body: JSON.stringify({ confirmationToken: confirmation.token }),
      });
      if (result.result === 'fallback_instamart_app') {
        await Linking.openURL(result.deepLink ?? INSTAMART_APP_URL);
        setPlacedMessage('Your Instamart cart is synced. Finish checkout in Swiggy.');
      } else {
        setPlacedMessage(
          result.result === 'partial_success'
            ? 'Instamart placed part of this multi-store order. Review each order below.'
            : 'Instamart order placed successfully.',
        );
      }
      setConfirmation(null);
      setEligibility(null);
      await loadOrders();
    } catch (checkoutError) {
      setConfirmation(null);
      setEligibility(null);
      setError(errorMessage(checkoutError, 'Instamart checkout could not be completed.'));
    } finally {
      setBusy(null);
    }
  }, [api, confirmation, loadOrders, providerPath]);

  const openInstamart = useCallback(() => void Linking.openURL(INSTAMART_APP_URL), []);

  const selectedAddress = useMemo(
    () => addresses.find((address) => address.id === selectedAddressId) ?? null,
    [addresses, selectedAddressId],
  );
  const allResolved = useMemo(
    () =>
      Boolean(
        plan && plan.length > 0 && plan.every((resolution) => resolution.state === 'resolved'),
      ),
    [plan],
  );

  if (connected === null) return <PotLoader label="Checking Swiggy" />;

  if (!connected) {
    return (
      <View style={flow.card} testID="instamart-connect-card">
        <Text style={styles.eyebrow}>Swiggy Instamart</Text>
        <Text style={flow.title}>Connect your account</Text>
        <Text style={flow.body}>
          Sign in on Swiggy with phone and OTP. Cooklink never sees either one, and nothing is
          ordered without a fresh confirmation.
        </Text>
        {error ? <ErrorNote>{error}</ErrorNote> : null}
        <ActionButton
          label={busy === 'connect' ? 'Opening Swiggy…' : 'Connect Swiggy'}
          disabled={busy !== null}
          testID="connect-swiggy-button"
          onPress={connect}
        />
      </View>
    );
  }

  return (
    <View style={flow.stack} testID="instamart-order-flow">
      <View style={flow.connectionRow}>
        <View style={flow.connectionCopy}>
          <Text style={styles.eyebrow}>Swiggy connected</Text>
          <Text style={flow.connectionBody}>
            Exact products and live totals come from Instamart.
          </Text>
        </View>
        <PressableScale
          accessibilityRole="button"
          accessibilityLabel="Disconnect Swiggy"
          disabled={busy !== null}
          style={flow.linkButton}
          onPress={disconnect}
        >
          <Text style={flow.linkText}>{busy === 'disconnect' ? 'Working…' : 'Disconnect'}</Text>
        </PressableScale>
      </View>

      {error ? <ErrorNote>{error}</ErrorNote> : null}
      {placedMessage ? (
        <View style={flow.successCard} testID="instamart-order-result">
          <Text style={flow.successTitle}>{placedMessage}</Text>
        </View>
      ) : null}

      <FlowHeading eyebrow="1 · Address" title="Where should Instamart deliver?" />
      {addresses.length === 0 ? (
        <View style={flow.card}>
          <Text style={flow.body}>
            No saved Swiggy address was returned. Add one in Swiggy first.
          </Text>
          <ActionButton label="Open Instamart" secondary onPress={openInstamart} />
        </View>
      ) : (
        <View style={flow.stackSmall}>
          {addresses.map((address) => (
            <AddressOption
              key={address.id}
              address={address}
              selected={address.id === selectedAddressId}
              onSelect={selectAddress}
            />
          ))}
        </View>
      )}

      {selectedAddress ? (
        <>
          <FlowHeading eyebrow="2 · Products" title="Choose exact packs" />
          {plan === null ? (
            <PotLoader label="Matching Instamart products" />
          ) : addressLoadFailed ? (
            <View style={flow.card}>
              <Text style={flow.body}>
                Instamart products could not be loaded for this address.
              </Text>
              <ActionButton label="Try again" secondary onPress={retryAddressLoad} />
            </View>
          ) : plan.length === 0 ? (
            <View style={flow.card}>
              <Text style={flow.body}>
                Keep at least one suggested grocery before matching products.
              </Text>
            </View>
          ) : (
            <View style={flow.stackSmall}>
              {plan.map((resolution) => (
                <MatchCard
                  key={resolution.cartItem.id}
                  resolution={resolution}
                  busy={busy === resolution.cartItem.id}
                  onChoose={chooseProduct}
                  onClear={clearProduct}
                />
              ))}
            </View>
          )}
        </>
      ) : null}

      {allResolved ? (
        <View style={flow.card} testID="instamart-cart-mode-card">
          <Text style={styles.eyebrow}>3 · Cart policy</Text>
          <Text style={flow.title}>What about items already in Instamart?</Text>
          <Text style={flow.body}>
            Choose deliberately—Swiggy’s update replaces the complete cart.
          </Text>
          <View style={flow.buttonRow}>
            <ChoiceButton
              label="Keep existing"
              selected={cartMode === 'preserve'}
              onPress={preserveCart}
            />
            <ChoiceButton
              label="Replace cart"
              selected={cartMode === 'replace'}
              onPress={replaceCart}
            />
          </View>
          <ActionButton
            label={busy === 'build-cart' ? 'Building cart…' : 'Review Instamart cart'}
            disabled={!cartMode || busy !== null}
            testID="review-instamart-cart-button"
            onPress={buildCart}
          />
        </View>
      ) : null}

      {review ? (
        <CartReview
          review={review}
          selectedPaymentId={paymentMethodId}
          busy={busy !== null}
          onSelectPayment={selectPayment}
          onPrepare={prepareConfirmation}
        />
      ) : null}

      {confirmation && eligibility && selectedAddress ? (
        <CheckoutConfirmation
          confirmation={confirmation}
          eligibility={eligibility}
          address={selectedAddress}
          paymentMethod={review?.availablePaymentMethods.find(
            (method) => method.id === confirmation.paymentMethodId,
          )}
          busy={busy === 'place-order'}
          onPlaceOrder={placeOrder}
          onOpenInstamart={openInstamart}
        />
      ) : null}

      {orders.length > 0 ? (
        <View style={flow.stackSmall} testID="instamart-orders">
          <FlowHeading eyebrow="Recent orders" title="Delivery status" />
          {orders.map((order) => (
            <OrderCard key={order.id} order={order} />
          ))}
        </View>
      ) : null}
    </View>
  );
}

const AddressOption = memo(function AddressOption({
  address,
  selected,
  onSelect,
}: {
  address: InstamartAddress;
  selected: boolean;
  onSelect: (addressId: string) => void;
}) {
  const select = useCallback(() => onSelect(address.id), [address.id, onSelect]);
  return (
    <PressableScale
      accessibilityRole="button"
      accessibilityState={selected ? SELECTED_ACCESSIBILITY_STATE : UNSELECTED_ACCESSIBILITY_STATE}
      style={selected ? ADDRESS_SELECTED_STYLE : flow.option}
      onPress={select}
    >
      <View style={flow.optionCopy}>
        <Text style={flow.optionTitle}>{address.label}</Text>
        <Text style={flow.optionBody}>{addressLine(address)}</Text>
      </View>
      <Text style={flow.optionMark}>{selected ? '✓' : '›'}</Text>
    </PressableScale>
  );
});

const MatchCard = memo(function MatchCard({
  resolution,
  busy,
  onChoose,
  onClear,
}: {
  resolution: InstamartMatchResolution;
  busy: boolean;
  onChoose: (cartItemId: string, product: InstamartProduct) => Promise<void>;
  onClear: (cartItemId: string) => Promise<void>;
}) {
  const clear = useCallback(
    () => void onClear(resolution.cartItem.id),
    [onClear, resolution.cartItem.id],
  );
  const candidates =
    resolution.state === 'unresolved'
      ? resolution.candidates
      : resolution.state === 'unavailable'
        ? resolution.alternatives
        : [];
  return (
    <View style={flow.card}>
      <Text style={styles.eyebrow}>{cartNeedName(resolution.cartItem)}</Text>
      {resolution.state === 'resolved' ? (
        <>
          <ProductSummary product={resolution.match.product} quantity={resolution.match.quantity} />
          <ActionButton
            label={busy ? 'Changing…' : 'Change product'}
            secondary
            disabled={busy}
            onPress={clear}
          />
        </>
      ) : (
        <>
          {resolution.state === 'unavailable' ? (
            <ErrorNote>The selected product is unavailable. Choose a replacement.</ErrorNote>
          ) : null}
          {candidates.length === 0 ? (
            <Text style={flow.body}>
              No matching Instamart product is available for this address.
            </Text>
          ) : (
            <View style={flow.stackTiny}>
              {candidates.map((product) => (
                <ProductOption
                  key={product.id}
                  cartItemId={resolution.cartItem.id}
                  product={product}
                  disabled={busy}
                  onChoose={onChoose}
                />
              ))}
            </View>
          )}
        </>
      )}
    </View>
  );
});

const ProductOption = memo(function ProductOption({
  cartItemId,
  product,
  disabled,
  onChoose,
}: {
  cartItemId: string;
  product: InstamartProduct;
  disabled: boolean;
  onChoose: (cartItemId: string, product: InstamartProduct) => Promise<void>;
}) {
  const choose = useCallback(
    () => void onChoose(cartItemId, product),
    [cartItemId, onChoose, product],
  );
  return (
    <PressableScale
      accessibilityRole="button"
      accessibilityLabel={`Choose ${product.brand} ${product.name}, ${product.packSize}`}
      disabled={disabled || !product.available}
      style={product.similar ? PRODUCT_SIMILAR_STYLE : flow.productOption}
      onPress={choose}
    >
      <View style={flow.optionCopy}>
        <Text style={flow.optionTitle}>{product.name}</Text>
        <Text style={flow.optionBody}>
          {product.brand} · {product.packSize} · {formatRupees(product.priceCents)}
        </Text>
      </View>
      {product.similar ? <Chip label="Similar" tint={colors.brandSoft} ink={colors.brand} /> : null}
      <Text style={flow.optionMark}>＋</Text>
    </PressableScale>
  );
});

function ProductSummary({ product, quantity }: { product: InstamartProduct; quantity: number }) {
  return (
    <View style={flow.productSummary}>
      <View style={flow.optionCopy}>
        <Text style={flow.optionTitle}>{product.name}</Text>
        <Text style={flow.optionBody}>
          {product.brand} · {product.packSize} · Qty {quantity}
        </Text>
      </View>
      <Text style={flow.price}>{formatRupees(product.priceCents * quantity)}</Text>
    </View>
  );
}

function CartReview({
  review,
  selectedPaymentId,
  busy,
  onSelectPayment,
  onPrepare,
}: {
  review: InstamartCartReview;
  selectedPaymentId: string | null;
  busy: boolean;
  onSelectPayment: (methodId: string) => void;
  onPrepare: () => Promise<void>;
}) {
  return (
    <View style={flow.card} testID="instamart-cart-review">
      <Text style={styles.eyebrow}>4 · Review</Text>
      <Text style={flow.title}>Your Instamart cart</Text>
      <View style={flow.stackTiny}>
        {review.items.map((item) => (
          <View key={item.productId} style={flow.reviewRow}>
            <View style={flow.optionCopy}>
              <Text style={flow.optionTitle}>{item.name}</Text>
              <Text style={flow.optionBody}>
                {item.brand} · {item.packSize} · Qty {item.quantity}
              </Text>
            </View>
            <Text style={flow.price}>{formatRupees(item.lineTotalCents)}</Text>
          </View>
        ))}
      </View>
      <View style={flow.bill}>
        {review.bill.map((line) => (
          <View key={line.label} style={flow.billRow}>
            <Text style={flow.billLabel}>{line.label}</Text>
            <Text style={flow.billValue}>{formatRupees(line.amountCents)}</Text>
          </View>
        ))}
      </View>
      {review.availablePaymentMethods.length === 0 ? (
        <ErrorNote>
          No Cooklink-supported payment method is available. Continue in Instamart.
        </ErrorNote>
      ) : (
        <View style={flow.stackTiny}>
          <Text style={styles.eyebrow}>Payment method</Text>
          {review.availablePaymentMethods.map((method) => (
            <PaymentOption
              key={method.id}
              method={method}
              selected={method.id === selectedPaymentId}
              onSelect={onSelectPayment}
            />
          ))}
        </View>
      )}
      <ActionButton
        label={busy ? 'Preparing confirmation…' : 'Continue to confirmation'}
        disabled={busy || !selectedPaymentId || review.hasUnavailableItems}
        testID="prepare-instamart-checkout-button"
        onPress={onPrepare}
      />
    </View>
  );
}

const PaymentOption = memo(function PaymentOption({
  method,
  selected,
  onSelect,
}: {
  method: InstamartPaymentMethod;
  selected: boolean;
  onSelect: (methodId: string) => void;
}) {
  const select = useCallback(() => onSelect(method.id), [method.id, onSelect]);
  return (
    <PressableScale
      accessibilityRole="radio"
      accessibilityState={selected ? SELECTED_ACCESSIBILITY_STATE : UNSELECTED_ACCESSIBILITY_STATE}
      style={selected ? PAYMENT_SELECTED_STYLE : flow.paymentOption}
      onPress={select}
    >
      <Text style={flow.optionTitle}>{method.label}</Text>
      <Text style={flow.optionMark}>{selected ? '●' : '○'}</Text>
    </PressableScale>
  );
});

function CheckoutConfirmation({
  confirmation,
  eligibility,
  address,
  paymentMethod,
  busy,
  onPlaceOrder,
  onOpenInstamart,
}: {
  confirmation: InstamartCheckoutConfirmation;
  eligibility: InstamartEligibility;
  address: InstamartAddress;
  paymentMethod: InstamartPaymentMethod | undefined;
  busy: boolean;
  onPlaceOrder: () => Promise<void>;
  onOpenInstamart: () => void;
}) {
  return (
    <View style={flow.confirmCard} testID="instamart-final-confirmation">
      <Text style={styles.eyebrow}>Final confirmation</Text>
      <Text style={flow.confirmTotal}>{formatRupees(confirmation.totalCents)}</Text>
      <Text style={flow.body}>
        {confirmation.itemCount} items · {confirmation.storeCount} stores ·{' '}
        {paymentMethod?.label ?? confirmation.paymentMethodId}
      </Text>
      <View style={flow.addressBox}>
        <Text style={flow.optionTitle}>Deliver to {address.label}</Text>
        <Text style={flow.optionBody}>{addressLine(address)}</Text>
      </View>
      {eligibility.reason === 'min_order_not_met' ? (
        <ErrorNote>Instamart requires a minimum cart value of ₹99. Add another item.</ErrorNote>
      ) : null}
      {eligibility.reason === 'disabled' ? (
        <ErrorNote>Real ordering is disabled in this environment.</ErrorNote>
      ) : null}
      {eligibility.fallback === 'instamart_app' ? (
        <ActionButton label="Finish in Instamart" onPress={onOpenInstamart} />
      ) : (
        <ActionButton
          label={busy ? 'Placing order…' : 'Place Instamart order'}
          disabled={busy || !eligibility.eligible}
          testID="place-instamart-order-button"
          onPress={onPlaceOrder}
        />
      )}
      <Text style={flow.warning}>
        Only this button places the order. The confirmation expires in one minute.
      </Text>
    </View>
  );
}

function OrderCard({ order }: { order: InstamartOrder }) {
  const trackingUrl = order.tracking?.trackingUrl ?? order.trackingUrl ?? null;
  const openTracking = useCallback(() => {
    if (trackingUrl) void Linking.openURL(trackingUrl);
  }, [trackingUrl]);
  const status = order.providerStatus ?? order.status ?? order.localStatus ?? 'placed';
  return (
    <View style={flow.card}>
      <View style={flow.reviewRow}>
        <View style={flow.optionCopy}>
          <Text style={flow.optionTitle}>Order {order.providerOrderId ?? order.id}</Text>
          <Text style={flow.optionBody}>{status.replaceAll('_', ' ')}</Text>
        </View>
        <Text style={flow.price}>{formatRupees(order.totalCents)}</Text>
      </View>
      {trackingUrl ? (
        <ActionButton label="Track in Swiggy" secondary onPress={openTracking} />
      ) : null}
    </View>
  );
}

function ChoiceButton({
  label,
  selected,
  onPress,
}: {
  label: string;
  selected: boolean;
  onPress: () => void;
}) {
  return (
    <PressableScale
      accessibilityRole="radio"
      accessibilityState={selected ? SELECTED_ACCESSIBILITY_STATE : UNSELECTED_ACCESSIBILITY_STATE}
      style={selected ? CHOICE_SELECTED_STYLE : flow.choiceButton}
      onPress={onPress}
    >
      <Text style={selected ? CHOICE_SELECTED_TEXT_STYLE : flow.choiceText}>{label}</Text>
    </PressableScale>
  );
}

function ActionButton({
  label,
  secondary = false,
  disabled = false,
  testID,
  onPress,
}: {
  label: string;
  secondary?: boolean;
  disabled?: boolean;
  testID?: string;
  onPress: () => void | Promise<void>;
}) {
  return (
    <PressableScale
      accessibilityRole="button"
      disabled={disabled}
      testID={testID}
      style={secondary ? ACTION_SECONDARY_STYLE : ACTION_PRIMARY_STYLE}
      onPress={onPress}
    >
      <Text style={secondary ? ACTION_SECONDARY_TEXT_STYLE : flow.actionText}>{label}</Text>
    </PressableScale>
  );
}

function FlowHeading({ eyebrow, title }: { eyebrow: string; title: string }) {
  return (
    <View style={flow.heading}>
      <Text style={styles.eyebrow}>{eyebrow}</Text>
      <Text style={flow.headingTitle}>{title}</Text>
    </View>
  );
}

function addressLine(address: InstamartAddress): string {
  return [address.line1, address.line2, address.city, address.pincode].filter(Boolean).join(', ');
}

function errorMessage(error: unknown, fallback: string): string {
  if (error instanceof ApiError) {
    try {
      const body = JSON.parse(error.body) as { message?: string; error?: string };
      return body.message ?? body.error?.replaceAll('_', ' ') ?? fallback;
    } catch {
      return fallback;
    }
  }
  return error instanceof Error ? error.message : fallback;
}

const flow = StyleSheet.create({
  stack: { gap: space.xl },
  stackSmall: { gap: space.md },
  stackTiny: { gap: space.sm },
  card: {
    gap: space.md,
    padding: space.lg,
    borderRadius: radius.md,
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.border,
    ...shadow.soft,
  },
  title: {
    fontFamily: fonts.display,
    fontSize: 22,
    lineHeight: 27,
    fontWeight: '700',
    color: colors.ink,
  },
  body: { fontSize: 14, lineHeight: 21, color: colors.inkSoft },
  connectionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    padding: space.md,
    borderRadius: radius.md,
    backgroundColor: colors.accentSoft,
  },
  connectionCopy: { flex: 1, gap: 3 },
  connectionBody: { fontSize: 12, lineHeight: 17, color: colors.inkSoft },
  linkButton: { paddingHorizontal: space.sm, paddingVertical: space.sm },
  linkText: { fontSize: 12, fontWeight: '800', color: colors.brand },
  successCard: {
    padding: space.lg,
    borderRadius: radius.md,
    backgroundColor: colors.accentSoft,
  },
  successTitle: { fontSize: 15, lineHeight: 21, fontWeight: '800', color: colors.accent },
  heading: { gap: 3, marginTop: space.sm },
  headingTitle: {
    fontFamily: fonts.display,
    fontSize: 22,
    lineHeight: 27,
    fontWeight: '700',
    color: colors.ink,
  },
  option: {
    minHeight: 72,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    padding: space.lg,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.card,
  },
  optionSelected: { borderColor: colors.accent, backgroundColor: colors.accentSoft },
  optionCopy: { flex: 1, gap: 3 },
  optionTitle: { fontSize: 15, lineHeight: 20, fontWeight: '800', color: colors.ink },
  optionBody: { fontSize: 12, lineHeight: 18, color: colors.inkSoft },
  optionMark: { fontSize: 19, fontWeight: '900', color: colors.accent },
  productOption: {
    minHeight: 68,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    padding: space.md,
    borderRadius: radius.sm,
    backgroundColor: colors.field,
  },
  productSimilar: { borderWidth: 1, borderColor: colors.border },
  productSummary: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    padding: space.md,
    borderRadius: radius.sm,
    backgroundColor: colors.accentSoft,
  },
  price: { fontSize: 14, fontWeight: '900', color: colors.ink },
  buttonRow: { flexDirection: 'row', gap: space.sm },
  choiceButton: {
    flex: 1,
    minHeight: 44,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: space.sm,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.field,
  },
  choiceSelected: { borderColor: colors.accent, backgroundColor: colors.accent },
  choiceText: { fontSize: 13, fontWeight: '800', color: colors.ink },
  choiceSelectedText: { color: colors.card },
  action: {
    minHeight: 50,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: space.lg,
    borderRadius: radius.md,
    backgroundColor: colors.accent,
  },
  actionSecondary: { backgroundColor: colors.field, borderWidth: 1, borderColor: colors.border },
  actionText: { fontSize: 14, fontWeight: '900', color: colors.card },
  actionSecondaryText: { color: colors.ink },
  reviewRow: { flexDirection: 'row', alignItems: 'center', gap: space.md },
  bill: { gap: space.sm, paddingTop: space.md, borderTopWidth: 1, borderTopColor: colors.border },
  billRow: { flexDirection: 'row', justifyContent: 'space-between', gap: space.md },
  billLabel: { fontSize: 13, color: colors.inkSoft },
  billValue: { fontSize: 13, fontWeight: '800', color: colors.ink },
  paymentOption: {
    minHeight: 50,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: space.md,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.field,
  },
  paymentSelected: { borderColor: colors.accent, backgroundColor: colors.accentSoft },
  confirmCard: {
    gap: space.md,
    padding: space.xl,
    borderRadius: radius.md,
    borderWidth: 2,
    borderColor: colors.accent,
    backgroundColor: colors.card,
    ...shadow.soft,
  },
  confirmTotal: {
    fontFamily: fonts.display,
    fontSize: 34,
    lineHeight: 40,
    fontWeight: '700',
    color: colors.ink,
  },
  addressBox: { gap: 3, padding: space.md, borderRadius: radius.sm, backgroundColor: colors.field },
  warning: { fontSize: 11, lineHeight: 16, textAlign: 'center', color: colors.inkSoft },
});

const ADDRESS_SELECTED_STYLE = StyleSheet.compose(flow.option, flow.optionSelected);
const PRODUCT_SIMILAR_STYLE = StyleSheet.compose(flow.productOption, flow.productSimilar);
const PAYMENT_SELECTED_STYLE = StyleSheet.compose(flow.paymentOption, flow.paymentSelected);
const CHOICE_SELECTED_STYLE = StyleSheet.compose(flow.choiceButton, flow.choiceSelected);
const CHOICE_SELECTED_TEXT_STYLE = StyleSheet.compose(flow.choiceText, flow.choiceSelectedText);
const ACTION_PRIMARY_STYLE = flow.action;
const ACTION_SECONDARY_STYLE = StyleSheet.compose(flow.action, flow.actionSecondary);
const ACTION_SECONDARY_TEXT_STYLE = StyleSheet.compose(flow.actionText, flow.actionSecondaryText);
