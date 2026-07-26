# Define automatic meal planning and effortless correction

Type: grilling
Status: resolved
Blocked by: 03

## Question

What exact rules should create an instantly active seven-day breakfast/lunch/dinner plan from Meal Style, Food Profiles, Serving Count, history, optional health emphasis, and weekly Special Meals, and how should swap, regenerate, search, Cook edits, and optional feedback change future suggestions without adding onboarding or approval friction?

## Answer

Cooklink creates one active Weekly Meal Plan as soon as a Household has Meal
Style, Serving Count, and any available Food Profile signal. It is never a
draft that waits for approval.

The generated plan covers seven calendar days starting today and includes
breakfast, lunch, and dinner. Missing inputs fall back to conservative defaults:
balanced everyday home food, vegetarian-safe options unless a Household or
Member Food Profile clearly allows eggs or meat, the Household's usual Serving
Count, and no Special Meal unless the Household has enabled occasional Special
Meals.

Automatic planning must feel useful before it feels personalized. The first
plan should be acceptable, plain, and editable; later plans improve from edits,
swaps, searches, regenerations, feedback, and repeated manual choices.

## Plan generation rules

### Inputs

Use these signals in priority order:

1. **Food Profile guardrails:** automatic generation should avoid foods the
   Household or any active diner avoids for that Serving Count. Food Profiles
   guide generated meals; they do not block intentional manual replacements.
2. **Diet style:** Vegetarian, Eggetarian, or Non-vegetarian controls the meal
   candidate pool. When profiles conflict, use the most restrictive candidate
   pool unless a specific meal Serving Count override excludes the restricted
   diner.
3. **Meal Style:** North Indian or South Indian controls the Household-level
   default home-food pattern and recipe style. This is separate from health
   emphasis and is not a per-person setting in V1.
4. **Serving Count:** the usual diner count determines recipe quantities,
   expected consumption, and grocery estimation. A planned meal may override
   it without changing the Household default.
5. **History:** prior completed meals, retained swaps, Cook edits, rejected
   suggestions, search selections, and optional feedback shape ranking.
6. **Optional health emphasis:** zero or more chips such as higher protein,
   more vegetables, or lighter meals change ranking and light recipe choices.
   They are soft signals and do not introduce calories, macros, medical diets,
   or nutrition analytics.
7. **Weekly Special Meals:** if enabled, schedule about one richer or
   celebratory meal per seven days. It remains an ordinary editable meal.

### Candidate rules

- Every slot receives one meal, not a list of suggestions.
- Breakfast uses lighter, quicker meals by default.
- Lunch and dinner may reuse components intelligently, but the same named meal
  should not repeat within three days unless history shows the Household often
  chooses it.
- Avoid back-to-back heavy meals.
- Avoid putting the weekly Special Meal in breakfast unless the Household has
  repeatedly chosen that pattern.
- Prefer familiar Indian home cooking over restaurant-style dishes.
- Prefer meals with ingredients likely available from the Estimated Pantry or
  easily supplied through Instamart.
- Do not optimize for exact pantry counts; grocery consequences are handled by
  Estimated Pantry and the Suggested Grocery Cart.
- When confidence is low, choose simple staples rather than asking onboarding
  questions.

### First active plan

The first plan is generated after Household setup with:

- seven days of breakfast, lunch, and dinner;
- the Household's Meal Style;
- the most restrictive active Food Profile;
- the usual Serving Count;
- optional health emphasis if chosen;
- one Special Meal if enabled;
- no approval step.

The app may show a plain system event in Household Chat such as "Cooklink
created this week's meal plan." It should not push a high-priority
notification unless the Household has no plan for today.

## Editing and correction rules

### Swap

Swap exchanges two planned meals in the same Household.

- Swap moves the meal identity and associated recipe guidance between slots,
  while each slot keeps its day, meal type, Serving Count override, and grocery
  timing context. Estimated Pantry and Suggested Grocery Cart recalculate from
  the resulting slot schedule.
- Swapping is applied immediately and creates one `meal.changed` event for each
  affected meal, or one compact `meal_plan.bulk_updated` event when the UI
  treats the swap as one operation.
- Swap teaches sequencing preference weakly. Example: moving dosa from dinner
  to breakfast increases dosa-for-breakfast ranking, but does not ban it from
  dinner.

### Regenerate

Regenerate replaces suggestions while respecting existing constraints.

- A person may regenerate one meal, one day, or the remaining week from the
  selected day forward.
- Regenerate never changes completed past meals.
- Regenerate keeps manually edited meals by default. The UI may offer
  "include edited meals" as an explicit option.
- Regenerate avoids meals the person just rejected in that scope.
- Regenerate uses optimistic concurrency. If another person changed the same
  meal, show the current meal and require a fresh tap.
- Bulk regeneration creates one `meal_plan.bulk_updated` event with a link to
  Meal Plan.
- Regenerate is a correction signal: rejected meals are downgraded for similar
  future slots, but a single regenerate is not treated as a permanent dislike.
  Single corrections nudge ranking; repeated corrections establish preference.

### Search

Search is the fastest precise correction.

- Search returns meals allowed by the Household's Food Profiles first.
- Search and manual replacement may show meals outside active Food Profiles
  when the person explicitly searches for or selects them. Cooklink labels the
  mismatch plainly and applies the replacement after confirmation.
- A manual override does not change Food Profiles unless the person explicitly
  edits the profile.
- A manual meal choice outside active Food Profiles is weak learning evidence.
  It does not change future automatic generation unless the pattern repeats or
  the Household updates its Food Profile.
- Choosing a search result applies it immediately to the selected slot.
- Repeatedly searching for and choosing a meal increases its ranking for
  similar slots, meal types, and day patterns.
- Search text is not shared as Chat content. Only the resulting confirmed meal
  change creates a system event.

### Cook edits

Cooks and Household Members have the same authority to edit the Weekly Meal
Plan.

- A Cook may replace a meal, adjust practical recipe guidance, or change a
  Serving Count override for a planned meal when the Household asked for fewer
  or more portions.
- Cook edits apply immediately and are attributed to the Cook.
- Cook edits never create purchasing authority. Ingredient gaps become Grocery
  Requests or affect the next Suggested Grocery Cart for Member review.
- If two active Cooks edit the same Household, the latest confirmed structured
  edit wins only after concurrency validation. Conflicts show the current meal
  and ask for a fresh confirmation.
- Repeated Cook substitutions are strong household preference signals because
  they reflect real preparation feasibility.

### Optional feedback

Feedback is never required to keep using Cooklink.

- Supported lightweight feedback is: liked, not again soon, too heavy, too
  light, too much work, ingredients hard to get, and serving count was off.
- Cooklink may offer feedback chips after a meal is completed and after a
  correction action such as Search replacement, Regenerate, Swap, or Cook edit.
  Feedback is never required, never blocks the edit, and never opens a longer
  questionnaire.
- Feedback can be attached to a planned or completed meal from Today, Meal
  Plan, Daily Cook View, or a live Chat card.
- Feedback updates ranking only; it does not rewrite the current plan unless
  the person also chooses Swap, Replace, or Regenerate.
- "Not again soon" suppresses the meal for the next two generated weeks unless
  it is manually chosen.
- "Liked" increases ranking but should not cause repetitive scheduling.
- "Too much work" lowers ranking for weekday breakfasts and ordinary weekday
  meals more than for Special Meals.
- "Ingredients hard to get" lowers ranking unless the needed ingredients are
  already likely in the Estimated Pantry or cart.
- "Serving count was off" adjusts future quantity estimation more than meal
  ranking.

## Learning model

Treat behavior as preference evidence, not onboarding data.

Strong signals:

- confirmed Cook or Member replacement of a generated meal;
- repeated manual selection from Search;
- repeated Serving Count overrides for a meal slot;
- explicit liked or not-again-soon feedback.

Medium signals:

- regenerating a single meal;
- moving a meal to a different meal type or day;
- choosing the same Special Meal pattern more than once.

Weak signals:

- viewing a Recipe Guide;
- opening a meal detail without changing it;
- bulk regeneration of a remaining week.

Never learn from:

- unconfirmed Chat suggestions;
- failed sends or failed structured mutations;
- another Household's behavior;
- private search text before a result is chosen;
- Member-only cart edits as direct meal preference, except where an ingredient
  is repeatedly removed because the related meal was changed.

Preference learning is Household-scoped. A Cook's edits improve suggestions for
that Household only and must not leak to other Households the Cook serves.
Cooklink does not use one Household's plan history, feedback, or Cook edits to
personalize another Household's generated plan in V1.

## No-friction product rules

- Do not add a meal-planning onboarding flow beyond the existing Meal Style,
  Food Profile, Serving Count, optional health emphasis, and Special Meal
  inputs.
- Do not ask users to approve the generated week.
- Do not ask routine preference questions after every meal.
- Do not block Today's Meals when the plan is incomplete; fill missing slots
  automatically and let people correct them.
- Do not introduce calories, macros, medical diet handling, inventory counts,
  restaurant meals, or non-Instamart commerce.
- Do not require the Cook to decide urgency or purchasing priority.

## Acceptance criteria

1. A new Household receives an active seven-day breakfast/lunch/dinner Weekly
   Meal Plan without an approval step.
2. The generated plan respects Food Profile guardrails and uses the most
   restrictive active diet style unless a meal-specific Serving Count override
   permits a narrower diner set.
3. Meal Style changes the default cuisine pattern without changing health
   emphasis.
4. Optional health emphasis supports zero or more soft chips and affects
   ranking and recipe choices without exposing calories, macros, or medical
   diet controls.
5. Weekly Special Meals schedule about one richer meal per week when enabled
   and no richer meal when disabled.
6. Swap, Search replacement, single-meal regeneration, day regeneration, and
   remaining-week regeneration from the selected day forward are available from
   Meal Plan.
7. Cook edits apply immediately, are attributed, and create structured meal
   events without requiring Member approval.
8. Grocery consequences remain suggestions or Grocery Requests until a
   Household Member reviews and confirms checkout.
9. Single corrections nudge future ranking, while repeated edits, searches,
   regenerations, Serving Count overrides, and optional feedback change future
   suggestions only inside the same Household.
10. No correction path creates extra onboarding, required feedback, routine
    pantry entry, or approval friction.
