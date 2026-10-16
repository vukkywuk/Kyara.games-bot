/**
 * Error hierarchy. Every error thrown by the bot is a KyaraError so the CLI can
 * map it to a message and an exit code without inspecting arbitrary objects.
 */

export type ExitCode = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7;

export const EXIT = {
  ok: 0,
  failure: 1,
  usage: 2,
  auth: 3,
  rateLimited: 4,
  ambiguous: 5,
  refused: 6,
  network: 7,
} as const satisfies Record<string, ExitCode>;

export class KyaraError extends Error {
  readonly exitCode: ExitCode;
  constructor(message: string, exitCode: ExitCode = EXIT.failure, options?: { cause?: unknown }) {
    super(message, options);
    this.name = new.target.name;
    this.exitCode = exitCode;
  }
}

/** The server answered with a non-2xx status. `code` is the server's `error` field. */
export class KyaraApiError extends KyaraError {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly path: string,
  ) {
    super(message, status === 401 ? EXIT.auth : status === 429 ? EXIT.rateLimited : EXIT.failure);
  }
}

/** No usable session, or the server rejected the token. */
export class AuthRequiredError extends KyaraError {
  constructor(message = 'Not logged in. Run `kyara session login` first.') {
    super(message, EXIT.auth);
  }
}

/** The server asked the bot to slow down and the retries ran out. */
export class RateLimitedError extends KyaraError {
  constructor(
    message: string,
    readonly retryAfterMs: number | null,
  ) {
    super(message, EXIT.rateLimited);
  }
}

/** Could not reach the server at all (DNS, TCP, TLS, timeout on a read). */
export class NetworkError extends KyaraError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, EXIT.network, options);
  }
}

/** The response did not match its schema; the site probably changed. */
export class SchemaMismatchError extends KyaraError {
  constructor(
    readonly path: string,
    readonly issues: string,
  ) {
    super(`Unexpected response shape from ${path}: ${issues}`);
  }
}

/**
 * A state-changing request was sent but we cannot tell whether the server applied it
 * (timeout, connection reset, 5xx). Never retry blindly: inspect the account first.
 */
export class AmbiguousOutcomeError extends KyaraError {
  constructor(
    message: string,
    readonly actionId: string,
    options?: { cause?: unknown },
  ) {
    super(message, EXIT.ambiguous, options);
  }
}

/** A guard (budget, confirmation, duplicate protection, prerequisite) refused the action. */
export class ActionRefusedError extends KyaraError {
  constructor(
    message: string,
    readonly reason:
      | 'not_confirmed'
      | 'over_budget'
      | 'insufficient_funds'
      | 'duplicate'
      | 'pending_unknown'
      | 'prerequisite'
      | 'invalid_input',
  ) {
    super(message, reason === 'invalid_input' ? EXIT.usage : EXIT.refused);
  }
}

/** Human verification (Turnstile / login) is required and could not be completed. */
export class HumanVerificationError extends KyaraError {
  constructor(message: string) {
    super(message, EXIT.auth);
  }
}

export class UsageError extends KyaraError {
  constructor(message: string) {
    super(message, EXIT.usage);
  }
}

/** Translations of the server's error codes, taken from the site's own client. */
const SERVER_CODES: Record<string, string> = {
  unauthorized: 'Login required.',
  chakra: 'Not enough chakra.',
  cost_changed: 'The pack cost changed since it was quoted; re-check and try again.',
  catalog_loading: 'The character catalogue is still loading on the server.',
  daily_limit: 'Daily limit reached for this pack; come back tomorrow.',
  pack_unavailable: 'This pack is not available right now.',
  grant_required: 'This pack can only be obtained as a reward.',
  nothing_to_claim: 'Nothing to claim right now.',
  pass_required: 'A fresh anti-bot pass is required (Turnstile).',
  guest_limit: 'Guest accounts are limited; link a Discord account.',
  invalid_price: 'Invalid price.',
  invalid_duration: 'Invalid duration.',
  not_listable: 'You have no copy available to sell for this card.',
  use_buyout: 'Your maximum reaches the buyout price: buy it directly instead.',
  bid_too_low: 'Bid too low.',
  own_listing: 'This is your own listing.',
  listing_closed: 'This listing has ended.',
  has_bids: 'Cannot cancel: the listing already has bids.',
  too_many_listings: 'Maximum number of active listings reached.',
  too_many_orders: 'Maximum number of buy orders reached.',
  too_many_trades: 'Too many pending trades.',
  trade_closed: 'This trade is no longer pending.',
  rate_limited: 'Too many actions at once; wait a few seconds.',
  market_locked: 'The market is not open to this account yet.',
  not_found: 'Not found.',
  maintenance: 'The site is in maintenance.',
};

export function describeServerCode(code: string, fallback?: string): string {
  return SERVER_CODES[code] ?? fallback ?? code;
}
