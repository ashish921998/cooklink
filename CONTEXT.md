# Cooklink

Cooklink coordinates everyday meal planning, cooking, and grocery replenishment for one household and its hired cook.

## Language

**Household**:
The shared Cooklink space for the people who plan and consume meals together and up to two active Cooks who prepare them.

**Household Owner**:
The Household Member who creates the Household, manages membership, and connects its Cook.
_Avoid_: Administrator

**Household Member**:
A person in the Household who can maintain food preferences, manage the Weekly Meal Plan, approve Grocery Requests, and place Grocery Orders.
_Avoid_: User, resident

**Household Invite**:
A phone-bound, role-specific, single-use link shared by the Household Owner through WhatsApp for a recipient to join as either a Household Member or Cook. It requires matching phone verification, may be revoked, and expires after seven days.
_Avoid_: Household code, open invite

**Household Role**:
The single role a person holds within one Household: Household Owner, Household Member, or Cook. The same person may be a Member at home and a Cook in other Households, but never holds two roles in the same Household.
_Avoid_: Global user type, account mode

**Cook**:
One of up to two people hired by a Household to prepare its meals, who may work across as many as 30 active Households. A Cook can edit each Household's planned meals and identify missing groceries but has no purchasing authority.

**Household Chat**:
The single conversation belonging to one Household and shared by its Cooks and Household Members, supporting text, photos, recorded voice notes, and automatic meal-plan and grocery-request updates.
_Avoid_: Direct message, support chat

**Grocery Request**:
A missing ingredient described naturally by a Cook through text or speech for review by Household Members. It is matched to grocery products only when the Household prepares an order.
_Avoid_: Grocery order, shopping list

**Grocery Order**:
An approved purchase placed by a Household Member through a grocery provider.
_Avoid_: Grocery request

**Suggested Grocery Cart**:
Cooklink's editable proposal for the next three days of planned meals, based on the Estimated Pantry and approved Grocery Requests. It becomes a Grocery Order only after a Household Member reviews and confirms checkout.
_Avoid_: Automatic order, shopping list

**Cooklink Checkout**:
The member-confirmed placement of an eligible Grocery Order without leaving Cooklink. Orders outside the grocery provider's supported limits continue through the provider's own experience.
_Avoid_: Automatic order, background order

**Weekly Meal Plan**:
The Household's active seven-day schedule of breakfast, lunch, and dinner, generated automatically from Food Profiles and prior plan changes and editable by the Cook or any Household Member. A generated Weekly Meal Plan is active immediately, not a proposal awaiting approval.
_Avoid_: Draft plan, daily plan, menu

**Daily Cook View**:
The Cook's focused view of the confirmed meals and preparation guidance needed for the current day, with limited visibility into upcoming preparation.
_Avoid_: Cook dashboard

**Recipe Guide**:
Concise step-by-step cooking instructions for a planned meal, available as text and on-demand voice in the Cook's selected language. V1 supports English and Hindi.
_Avoid_: Recipe article, automatic narration

**Food Profile**:
A lightweight, skippable record of a Household or Household Member's diet style—Vegetarian, Eggetarian, or Non-vegetarian—and any foods they choose to avoid. It guides automatic planning but does not prevent an intentional manual meal replacement.
_Avoid_: Allergy profile, medical profile, dietary questionnaire

**Meal Style**:
The Household's preference for North Indian or South Indian home cooking, balanced by default with optional plain-language emphasis such as higher protein, more vegetables, or lighter meals. V1 treats Meal Style as a Household-level default, not a per-person setting.
_Avoid_: Cuisine taxonomy, nutrition programme

**Special Meal**:
An optional richer or celebratory meal automatically included approximately once per week when enabled and editable like any other planned meal.
_Avoid_: Cheat meal

**Serving Count**:
The Household's usual number of diners for a meal, with an optional override on an individual planned meal. It is the basis for recipe quantities, expected consumption, and grocery suggestions.
_Avoid_: Household size, attendance form

**Estimated Pantry**:
Cooklink's non-authoritative estimate of groceries likely available to a Household, calculated from completed Grocery Orders and expected recipe consumption. Grocery Requests and order-review adjustments correct real-world exceptions without requiring routine stock entry.
_Avoid_: Inventory, exact stock, pantry ledger
