# Instamart MCP contract findings for Cooklink V1

Research date: 2026-07-25
Source policy: official Swiggy Builders Club documentation only.

## Decision summary

Cooklink's intended Instamart journey is supported in principle: an authenticated household member can resolve a saved address, search address-specific products and variants, replace the Instamart cart, review its bill and available payment methods, explicitly confirm checkout, and then view recent orders or track an active order. Cooklink is a multi-tenant in-app platform, so it must use Swiggy's delegated OAuth model with a separate Swiggy authorization and token for each ordering member.

This is not yet an unconditional production dependency. Swiggy MCP v1 is invite-based; Cooklink should prototype against a local stub, then pass staging and partner review before enabling real orders. The specification must preserve an Instamart-app fallback and must not promise that MCP production access, mobile redirect schemes, non-COD payment, or checkout for carts of ₹1,000 or more will be available until confirmed during onboarding and staging.

## Supported journey

1. **Address and product discovery.** `search_products` requires an `addressId` from `get_addresses` and a query, and returns only products available at that address, including pack-size/quantity variants. Swiggy's guidance says to search before adding and ask the user which specific variant they want. Therefore Cooklink may propose matches, but the approved cart must expose exact brand/variant/pack selection rather than silently treating “onion” as a purchasable SKU. [search_products](https://mcp.swiggy.com/builders/docs/reference/instamart/search_products/) [get_addresses](https://mcp.swiggy.com/builders/docs/reference/instamart/get_addresses/)
2. **Cart construction.** `update_cart` takes an address plus `spinId`/quantity items and **replaces the entire cart**, rather than incrementally adding only the supplied item. Cooklink must merge its intended items with the current cart or deliberately warn before replacement. Cart mutation is idempotent for identical arguments. [update_cart](https://mcp.swiggy.com/builders/docs/reference/instamart/update_cart/) [production retry contract](https://mcp.swiggy.com/builders/docs/build/ship-to-production/)
3. **Review before checkout.** `get_cart` returns all items, the bill breakdown, and `availablePaymentMethods`. Cooklink must show the complete item list, total, available payment method(s), selected delivery address, and multi-store status before asking for confirmation. It must show only payment methods returned by `get_cart`. [get_cart](https://mcp.swiggy.com/builders/docs/reference/instamart/get_cart/) [checkout](https://mcp.swiggy.com/builders/docs/reference/instamart/checkout/)
4. **Explicit confirmation is mandatory.** `checkout` is mutating, creates the order and confirms payment in one operation, and Swiggy says it must never be called without a fresh, clear user confirmation after cart review. An automatically generated meal plan or suggested cart cannot count as checkout consent. [checkout](https://mcp.swiggy.com/builders/docs/reference/instamart/checkout/)
5. **Cart-value boundary and app fallback.** The checkout guidance says to verify that the total is **below ₹1,000**; checkout is not allowed above the allowed limit, and larger carts should be completed in the Instamart app. The MCP-updated cart synchronizes to the app. For a conservative V1 contract, treat **₹1,000 or more** as app-fallback territory unless Swiggy clarifies the boundary. The docs do not promise that `checkout` returns a deep link or that Cooklink's mobile redirect can open a specific cart screen, so V1 should say “Open Instamart to finish” rather than promise a seamless deep-link handoff. [checkout](https://mcp.swiggy.com/builders/docs/reference/instamart/checkout/)
6. **Multi-store behavior.** Checkout can split one cart into separate orders and can return partial success. Cooklink must disclose the number of stores before confirmation and show each resulting order separately. [checkout](https://mcp.swiggy.com/builders/docs/reference/instamart/checkout/)
7. **History and tracking.** `get_orders` returns basic order details from only the last 15 days and can filter active orders. `track_order` requires an order ID plus delivery coordinates and returns current status, ETA, delivery-partner location, store, address, items, and payment details. Polling should be no faster than every ten seconds. `get_order_details` is available for a specific order. Cancellation is not exposed as a tool; official guidance sends the user to Swiggy customer care. [get_orders](https://mcp.swiggy.com/builders/docs/reference/instamart/get_orders/) [track_order](https://mcp.swiggy.com/builders/docs/reference/instamart/track_order/) [grocery journey](https://mcp.swiggy.com/builders/docs/build/recipes/order-groceries/)

## Authentication and mobile implications

- Cooklink fits Swiggy's definition of a **platform operator**: an in-app product brokering Swiggy tools for its end users. It should use delegated OAuth 2.1 authorization-code flow with PKCE, not one shared developer or household credential. Every ordering member authorizes their own Swiggy account in Swiggy's browser UI using phone and OTP; Cooklink never receives the password or OTP. Tokens, addresses, carts, orders, and history remain tied to that authenticated Swiggy user. [delegated auth](https://mcp.swiggy.com/builders/docs/start/enterprise/delegated-auth/)
- Tokens must be stored securely per user and never shared. Access tokens live five days; refresh-token issuance is not available in v1.0, so expiry or a 401 requires restarting authorization (often silently while the longer-lived session remains valid). A revoked session can require phone/OTP again. [delegated auth](https://mcp.swiggy.com/builders/docs/start/enterprise/delegated-auth/) [authenticate](https://mcp.swiggy.com/builders/docs/start/authenticate/)
- Redirect URIs are exact-match allowlisted. HTTPS is the default; localhost is allowed for development. The docs list custom schemes only for known MCP clients and say other platform-specific schemes are case-by-case. Therefore an Expo deep-link/custom-scheme callback is **an onboarding dependency**, not something the V1 spec can assume. A safe mobile architecture uses an allowlisted HTTPS universal/app link callback, subject to Swiggy approval. [authenticate](https://mcp.swiggy.com/builders/docs/start/authenticate/) [access and onboarding](https://mcp.swiggy.com/builders/docs/operate/access/)
- v1 scopes are broad (`mcp:tools`) rather than Instamart-only or read/write split, and per-application server allowlists are not yet enforced. Cooklink should call only the Instamart endpoint by product policy, but OAuth does not currently provide a fine-grained `instamart.write` grant. [authenticate](https://mcp.swiggy.com/builders/docs/start/authenticate/)

## Payment contract ambiguity

The checkout reference says Cooklink must display `availablePaymentMethods` returned by `get_cart`, may pass one of those methods, and otherwise lets the system select the available method. However, Swiggy's official end-to-end grocery recipe also says “COD-only in v1.” These official pages are not fully aligned. Cooklink should conservatively:

- promise only the method(s) returned by the live cart;
- never display an assumed card/UPI/COD choice;
- treat COD as the only currently documented end-to-end method until staging proves otherwise; and
- make supported payment methods a staging acceptance test and partner-onboarding question.

Sources: [checkout reference](https://mcp.swiggy.com/builders/docs/reference/instamart/checkout/) [get_cart reference](https://mcp.swiggy.com/builders/docs/reference/instamart/get_cart/) [official grocery journey](https://mcp.swiggy.com/builders/docs/build/recipes/order-groceries/)

## Failures and recovery

- Current failures use `success: false` with a human-readable `error.message`; stable symbolic `error.code` values are only planned. Branch on HTTP status plus message for now. Domain failures such as out-of-stock, unserviceable address, minimum order not met (documented as under ₹99), and an expired cart should be surfaced for user correction rather than blindly retried. [error codes](https://mcp.swiggy.com/builders/docs/reference/errors/) [grocery journey](https://mcp.swiggy.com/builders/docs/build/recipes/order-groceries/)
- Reads and identical cart replacements are retryable. **Checkout is non-idempotent.** After a network error or 5xx, wait briefly and call `get_orders` to determine whether the order was placed before retrying checkout. Cooklink must not create duplicate orders through blind retries. [production retry contract](https://mcp.swiggy.com/builders/docs/build/ship-to-production/)
- Multi-store checkout may partially succeed; treat each returned order independently and do not describe the whole operation as failed or successful without inspecting every result. [checkout](https://mcp.swiggy.com/builders/docs/reference/instamart/checkout/)
- 401 requires OAuth again; bad input should not retry; upstream 502/503/504 may use bounded exponential backoff; persistent failures can use `report_error`. User-facing retries should stay within a 30-second budget. [error codes](https://mcp.swiggy.com/builders/docs/reference/errors/) [production retry contract](https://mcp.swiggy.com/builders/docs/build/ship-to-production/)

## Access and release gates

- v1 production is invite-based. Cooklink can start with a local dev stub, receive staging credentials during review, and use `mcp-staging.swiggy.com/{server}` with seeded data and no real orders. Production follows a working staging integration; Swiggy documents at least 48 green hours as a production checklist gate. [access and onboarding](https://mcp.swiggy.com/builders/docs/operate/access/) [production checklist](https://mcp.swiggy.com/builders/docs/build/ship-to-production/)
- Because Cooklink serves many end users, it should apply as a platform operator/enterprise integration. Swiggy says this path is variable and typically takes 4+ weeks, with commercial terms and additional security/compliance review. The application needs exact redirect URIs, architecture, expected traffic, data handling/privacy, security contact, and the Instamart server declaration. [access and onboarding](https://mcp.swiggy.com/builders/docs/operate/access/) [production access](https://mcp.swiggy.com/builders/access/)
- The production checklist also requires confirmation UX, OAuth/error handling, check-before-retry for checkout, observability, data/consent handling, a support runbook, and gradual rollout. [production checklist](https://mcp.swiggy.com/builders/docs/build/ship-to-production/)

## Required changes or guardrails for the Cooklink V1 specification

1. Replace “all members share the household's Instamart cart/history” with: **each member who orders connects their own Swiggy account; the active Swiggy cart, addresses, order history, and payment options belong to that member's session.** Cooklink's internal approved Grocery Requests can remain household-shared.
2. Keep the Cook's Grocery Request as a Cooklink object. Cooks need not connect Swiggy and must not trigger checkout. A connected member converts approved requests into exact Instamart variants.
3. Add an exact-product/pack review step. AI may recommend a SKU, but the UI must make variant selection and the final cart visible.
4. Define checkout eligibility as total below ₹1,000 and an available returned payment method; route ₹1,000-or-more and unsupported cases to the Instamart app with the synchronized cart.
5. Do not promise a direct cart deep link from Expo. Treat the OAuth callback and any app-to-Instamart handoff URI as partner-approved mobile integration details.
6. Do not use Swiggy's 15-day per-user history as the canonical Estimated Pantry ledger. Persist Cooklink's own confirmed-order line items and consumption estimates under an approved data-retention policy; use Swiggy history only for reconciliation/recovery.
7. Add partial-success and duplicate-order safeguards, including `get_orders` verification before retrying a failed checkout.
8. Treat production ordering as a gated capability. The app can ship meal planning, household chat, Grocery Requests, and a stub/staging cart before Swiggy grants production access, but must label real Instamart ordering as unavailable until approval.

## Open questions to take to Swiggy onboarding

- Will Swiggy allow Cooklink's Expo iOS/Android callback via a custom scheme, or require an HTTPS universal/app link?
- Is Instamart checkout currently COD-only, or can production carts return other `availablePaymentMethods`?
- Is the rejected boundary `>= ₹1,000` exactly, given the docs' mixed “above the allowed limit” and “below ₹1000” wording?
- Does the large-cart fallback expose a supported Instamart cart deep link, or only rely on cart synchronization plus opening the app?
- Are carts truly isolated per authenticated member when several members belong to one Cooklink Household, and are there partner-supported household/shared-cart semantics?
- What final rate limits, commercial terms, data-retention terms, branding requirements, and production geographies apply to Cooklink?
