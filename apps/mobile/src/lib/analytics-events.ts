export type HouseholdAnalyticsRole = 'owner' | 'member' | 'cook';

export type AnalyticsEventProperties = {
  week_day_selected: {
    day_offset: number;
    relative_day: 'today' | 'tomorrow' | 'later';
    household_role: HouseholdAnalyticsRole;
    source: 'today_feed';
  };
  meal_plan_opened: {
    household_role: HouseholdAnalyticsRole;
    source: 'bottom_tab' | 'today_empty_state';
  };
  recipe_opened: {
    has_recipe: boolean;
    household_role: HouseholdAnalyticsRole;
    meal_type: string;
    source: 'meal_plan';
  };
  cart_review_opened: {
    cart_mode: 'preserve' | 'replace';
    has_unavailable_items: boolean;
    item_count: number;
    provider: 'instamart';
  };
  checkout_started: {
    has_unavailable_items: boolean;
    item_count: number;
    provider: 'instamart';
  };
};

export type AnalyticsEventName = keyof AnalyticsEventProperties;
