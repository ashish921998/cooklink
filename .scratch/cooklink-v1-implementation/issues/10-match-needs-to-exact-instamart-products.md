# 10 — Match grocery needs to exact Instamart products

**What to build:** Turn the Household's editable grocery needs into an exact,
reviewable Instamart cart without silently choosing brands, pack sizes, or
replacements and without erasing unrelated items already in the Member's
Instamart cart.

**Blocked by:** 09 — Generate the three-day Suggested Grocery Cart.

**Status:** ready-for-agent

- [ ] A Member can connect their own Swiggy account through delegated OAuth;
      Cooks never see connection or cart controls.
- [ ] Product search is scoped to the selected delivery address and presents
      exact brand, variant, pack size, price, and availability.
- [ ] A vague grocery need remains unresolved until the Member chooses an exact
      product.
- [ ] Updating the Instamart cart deliberately preserves or replaces its full
      current contents according to the Member's reviewed choice.
- [ ] If a selected product becomes unavailable, Cooklink offers up to three
      exact available alternatives and requires deliberate replacement or
      removal.
- [ ] The final review shows every item, quantity, bill breakdown, address,
      store count, and only payment methods returned by Instamart.
- [ ] Provider failures remain correctable without losing the Household's
      Suggested Grocery Cart.
- [ ] A local provider stub makes the complete product-matching journey
      testable without production credentials.

