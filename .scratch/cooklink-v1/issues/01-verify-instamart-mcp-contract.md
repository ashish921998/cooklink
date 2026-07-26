# Verify the Instamart MCP contract for Cooklink

Type: research
Status: resolved
Blocked by:

## Question

What can the current official Swiggy Instamart MCP contract support for Cooklink's search, cart, explicit-confirmation checkout, order history, and tracking journeys, and which authentication, price-limit, partner-onboarding, multi-user, failure, and production-access constraints must the V1 specification preserve?

## Answer

The official contract supports the intended discover → cart → explicit-confirmation checkout → history/tracking journey, but Cooklink must use delegated per-member Swiggy OAuth, preserve exact SKU review and the below-₹1,000 checkout boundary, handle non-idempotent and partial-success checkout safely, and treat Expo redirects, payment methods, app handoff, and production access as staging/onboarding gates. Full cited findings and the required V1 guardrails are in [Instamart MCP contract findings](../research/instamart-mcp-contract.md).
