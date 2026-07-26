# 11 — Complete confirmed checkout and order recovery

**What to build:** Let a Member explicitly confirm and place an eligible
Instamart order, safely fall back for unsupported carts, and recover from
uncertain or partial outcomes without duplicate orders.

**Blocked by:** 10 — Match grocery needs to exact Instamart products.

**Status:** ready-for-agent

- [ ] Cooklink shows the canonical cart, address, selected returned payment
      method, store count, and total immediately before asking for confirmation.
- [ ] Checkout never runs without a fresh explicit Member confirmation and a
      server-side Household Role check.
- [ ] Eligible carts below ₹1,000 can use MCP checkout; carts at or above
      ₹1,000 and carts without a returned payment method use Instamart fallback.
- [ ] Fallback relies on synchronized cart state but does not promise a direct
      deep link to the cart.
- [ ] A unique checkout attempt and append-only audit trail prevent blind
      duplicate submission.
- [ ] After a network or server uncertainty, order history is checked before
      any retry is considered.
- [ ] Multi-store partial success is shown per resulting order rather than as
      one misleading success or failure.
- [ ] Members can view recent order state and tracking, while cancellation
      guidance follows the provider contract.
- [ ] Real ordering is visibly feature-gated until Swiggy staging and
      production access are approved.

