import { z } from 'zod';
import type { KyaraHttpClient } from '../KyaraHttpClient.js';
import {
  BootstrapSchema,
  ClaimResultSchema,
  CollectionSchema,
  MeSchema,
  OpenManyResultSchema,
  OpenResultSchema,
  PackStateSchema,
  PassSchema,
  ProgressSchema,
  WishlistSchema,
} from '../schemas/account.js';
import type { ClaimKind } from '../schemas/account.js';
import { UsageError } from '../../utils/errors.js';

/** Endpoints that need a session. Shapes are INFERRED until verified with `kyara api verify`. */
export class AccountEndpoints {
  constructor(private readonly http: KyaraHttpClient) {}

  // ---- reads ----
  me = () => this.http.get('/me', MeSchema, { auth: 'required' });
  bootstrap = () => this.http.get('/me/bootstrap', BootstrapSchema, { auth: 'required' });
  collection = () => this.http.get('/me/collection', CollectionSchema, { auth: 'required', query: { lean: 1 } });
  packState = () => this.http.get('/me/packs', PackStateSchema, { auth: 'required' });
  progress = () => this.http.get('/me/progress', ProgressSchema, { auth: 'required' });
  wishlist = () => this.http.get('/me/wishlist', WishlistSchema, { auth: 'required' });
  wishlistOdds = () => this.http.get('/me/wishlist/odds', z.unknown(), { auth: 'required' });
  notifications = (unreadOnly = false, limit = 30) =>
    this.http.get('/me/notifications', z.unknown(), { auth: 'required', query: { unread: unreadOnly ? 1 : undefined, limit } });

  // ---- state-changing (call through ActionGuard, never directly from UI code) ----

  /** Exchanges a Turnstile token for a ~30 min "pass" required to open packs. */
  createPass = (turnstileToken: string) =>
    this.http.mutate('POST', '/auth/pass', PassSchema, { body: { turnstile: turnstileToken } });

  /**
   * Opens one pack. `requestId` is the site's idempotency key (`x-request-id`): the site
   * re-sends the same id when it retries, so reusing it must never open a second pack.
   * `maxChakra` is a spend ceiling checked by the server (`cost_changed` if exceeded).
   */
  openPack = (packId: string, opts: { requestId: string; pass: string | null; maxChakra?: number }) =>
    this.http.mutate('POST', `/packs/${encodeURIComponent(packId)}/open`, OpenResultSchema, {
      body: opts.maxChakra === undefined ? {} : { maxChakra: opts.maxChakra },
      headers: packHeaders(opts.requestId, opts.pass),
    });

  openPacks = (packId: string, opts: { count: number; requestId: string; pass: string | null; maxChakra?: number }) => {
    if (!Number.isInteger(opts.count) || opts.count < 1 || opts.count > 10) throw new UsageError('count must be 1..10');
    return this.http.mutate('POST', `/packs/${encodeURIComponent(packId)}/open-many`, OpenManyResultSchema, {
      body: opts.maxChakra === undefined ? { count: opts.count } : { count: opts.count, maxChakra: opts.maxChakra },
      headers: packHeaders(opts.requestId, opts.pass),
    });
  };

  claim = (kind: ClaimKind, id?: string) =>
    this.http.mutate('POST', '/me/progress/claim', ClaimResultSchema, { body: id ? { kind, id } : { kind } });

  setWish = (characterId: number, wished: boolean) =>
    this.http.mutate(wished ? 'PUT' : 'DELETE', `/me/wishlist/${characterId}`, WishlistSchema);

  logout = () => this.http.mutate('POST', '/auth/logout', z.unknown());
}

function packHeaders(requestId: string, pass: string | null): Record<string, string> {
  return { 'x-request-id': requestId, ...(pass ? { 'x-pass': pass } : {}) };
}
