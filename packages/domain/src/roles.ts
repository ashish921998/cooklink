import type { Capability } from './errors.js';

/**
 * The single role a person holds within one Household (issue: accounts &
 * roles). A person has exactly one role per Household; the same account may be
 * a Member at home and a Cook elsewhere.
 */
export type HouseholdRole = 'owner' | 'member' | 'cook';

/**
 * Capability matrix from the Household Chat permission contract (issue 06).
 *
 * This is the single source of truth for "what a role may do". Client role
 * checks are navigation/UX only; the server re-checks every capability here.
 */
const CAPABILITIES: Record<HouseholdRole, ReadonlySet<Capability>> = {
  owner: new Set<Capability>([
    'read_chat',
    'send_message',
    'edit_delete_own_message',
    'edit_meal_plan',
    'confirm_meal_suggestion',
    'approve_reject_request',
    'add_to_cart',
    'review_place_order',
    'manage_membership',
    'configure_notifications',
  ]),
  member: new Set<Capability>([
    'read_chat',
    'send_message',
    'edit_delete_own_message',
    'edit_meal_plan',
    'confirm_meal_suggestion',
    'approve_reject_request',
    'add_to_cart',
    'review_place_order',
    'configure_notifications',
  ]),
  cook: new Set<Capability>([
    'read_chat',
    'send_message',
    'edit_delete_own_message',
    'edit_meal_plan',
    'confirm_meal_suggestion',
    'create_grocery_request',
    'edit_cancel_pending_request',
    'configure_notifications',
  ]),
};

export function can(role: HouseholdRole, capability: Capability): boolean {
  return CAPABILITIES[role].has(capability);
}

/**
 * Cooks never see checkout. Used to hard-gate the ordering surface regardless
 * of how the request arrives (issue 07, AC#10).
 */
export function canTriggerCheckout(role: HouseholdRole): boolean {
  return can(role, 'review_place_order');
}

/** Convenience predicates mirroring the permission table. */
export const capabilities = {
  canEditMealPlan: (role: HouseholdRole) => can(role, 'edit_meal_plan'),
  canCreateGroceryRequest: (role: HouseholdRole) => can(role, 'create_grocery_request'),
  canApproveRejectRequest: (role: HouseholdRole) => can(role, 'approve_reject_request'),
  canEditCancelPendingRequest: (role: HouseholdRole) => can(role, 'edit_cancel_pending_request'),
  canManageCart: (role: HouseholdRole) => can(role, 'add_to_cart'),
  canCheckout: canTriggerCheckout,
  canManageMembership: (role: HouseholdRole) => can(role, 'manage_membership'),
} as const;
