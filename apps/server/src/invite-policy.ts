import { createHash } from 'node:crypto';

export interface InviteAcceptanceInput {
  invitedPhoneHash: string;
  verifiedPhone: string;
  hasActiveHouseholdRole: boolean;
  role: 'member' | 'cook';
  activeHouseholdCooks: number;
  activeCookHouseholds: number;
}

export type InviteAcceptanceError =
  | 'invite_phone_mismatch'
  | 'household_role_already_exists'
  | 'household_cook_limit_reached'
  | 'cook_household_limit_reached';

export function validateInviteAcceptance(
  input: InviteAcceptanceInput,
): InviteAcceptanceError | null {
  if (input.invitedPhoneHash !== hashPhone(input.verifiedPhone)) {
    return 'invite_phone_mismatch';
  }
  if (input.hasActiveHouseholdRole) {
    return 'household_role_already_exists';
  }
  if (input.role === 'cook' && input.activeHouseholdCooks >= 2) {
    return 'household_cook_limit_reached';
  }
  if (input.role === 'cook' && input.activeCookHouseholds >= 30) {
    return 'cook_household_limit_reached';
  }
  return null;
}

export function normalizePhone(phone: string): string {
  return phone.replace(/[^\d+]/g, '');
}

export function hashPhone(phone: string): string {
  return createHash('sha256').update(normalizePhone(phone)).digest('hex');
}
