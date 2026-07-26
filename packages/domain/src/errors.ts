/** Domain-level errors. The Hono server maps these to HTTP responses and logs. */

export class DomainError extends Error {
  constructor(
    message: string,
    public readonly code: string,
  ) {
    super(message);
    this.name = 'DomainError';
  }
}

/**
 * Raised by the centralized authorization helpers when a principal is not an
 * active member of the Household, or lacks the required role/capability.
 *
 * The server MUST log every {@link AuthorizationDeniedError} (issue 07, AC#5)
 * and return a generic 403/404 to the client.
 */
export class AuthorizationDeniedError extends DomainError {
  constructor(
    message: string,
    public readonly detail: {
      userId: string;
      householdId?: string;
      capability?: Capability;
    },
  ) {
    super(message, 'authorization_denied');
    this.name = 'AuthorizationDeniedError';
  }
}

export class NotFoundError extends DomainError {
  constructor(message: string) {
    super(message, 'not_found');
    this.name = 'NotFoundError';
  }
}

export class ConflictError extends DomainError {
  constructor(
    message: string,
    public readonly current?: unknown,
  ) {
    super(message, 'conflict');
    this.name = 'ConflictError';
  }
}

export class ValidationError extends DomainError {
  constructor(message: string) {
    super(message, 'validation_error');
    this.name = 'ValidationError';
  }
}

export class PreconditionFailedError extends DomainError {
  constructor(message: string) {
    super(message, 'precondition_failed');
    this.name = 'PreconditionFailedError';
  }
}

export type Capability =
  | 'read_chat'
  | 'send_message'
  | 'edit_delete_own_message'
  | 'edit_meal_plan'
  | 'confirm_meal_suggestion'
  | 'create_grocery_request'
  | 'edit_cancel_pending_request'
  | 'approve_reject_request'
  | 'add_to_cart'
  | 'review_place_order'
  | 'manage_membership'
  | 'configure_notifications';
