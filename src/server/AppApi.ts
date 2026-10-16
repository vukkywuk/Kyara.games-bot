import { createHash } from 'node:crypto';
import { SettingsSchema } from '../config/SettingsStore.js';
import { z, ZodError } from 'zod';
import type { KyaraBot } from '../bot.js';
import { CLAIM_KINDS } from '../api/schemas/account.js';
import { LISTING_MAX_PAGE_SIZE, ListingQuerySchema } from '../api/schemas/market.js';
import { LADDER_KEYS } from '../api/schemas/public.js';
import type { GuardOptions, GuardOutcome } from '../services/ActionGuard.js';
import {
  ActionRefusedError,
  AmbiguousOutcomeError,
  AuthRequiredError,
  HumanVerificationError,
  KyaraApiError,
  KyaraError,
  NetworkError,
  RateLimitedError,
  SchemaMismatchError,
  UsageError,
} from '../utils/errors.js';
import { redactString } from '../utils/redact.js';
import type { BridgeService } from './BridgeService.js';
import type { EventHub } from './EventHub.js';
import { HttpError } from './http.js';
import type { MonitorService } from './MonitorService.js';

export interface ApiRequest {
  method: string;
  /** Path after /app-api, e.g. "/packs/all/open". */
  path: string;
  query: URLSearchParams;
  body: unknown;
}

type Handler = (req: ApiRequest, params: Record<string, string>) => Promise<unknown>;

export interface ApiResult {
  body: unknown;
  /** Set for cacheable responses (the catalogue). */
  etag?: string;
}

/** Converts bot errors into HTTP errors the UI can act on. Never leaks secrets. */
export function toHttpError(err: unknown): HttpError {
  if (err instanceof HttpError) return err;
  if (err instanceof ZodError) return new HttpError(400, 'bad_request', err.issues.map((i) => `${i.path.join('.') || 'value'}: ${i.message}`).join('; '));
  if (err instanceof URIError) return new HttpError(400, 'bad_request', 'Malformed URL');
  const msg = redactString((err as Error)?.message ?? 'Error');
  if (err instanceof AuthRequiredError) return new HttpError(401, 'auth_required', msg);
  if (err instanceof AmbiguousOutcomeError) return new HttpError(409, 'ambiguous', msg, { actionId: err.actionId });
  if (err instanceof ActionRefusedError) return new HttpError(409, 'refused', msg, { reason: err.reason });
  if (err instanceof HumanVerificationError) return new HttpError(412, 'pass_required', msg);
  if (err instanceof RateLimitedError) return new HttpError(429, 'rate_limited', msg, { retryAfterMs: err.retryAfterMs });
  if (err instanceof SchemaMismatchError) return new HttpError(502, 'schema_mismatch', msg);
  if (err instanceof NetworkError) return new HttpError(504, 'network', msg);
  if (err instanceof KyaraApiError) return new HttpError(502, 'kyara_error', msg, { kyaraStatus: err.status, kyaraCode: err.code });
  if (err instanceof UsageError) return new HttpError(400, 'bad_request', msg);
  if (err instanceof KyaraError) return new HttpError(500, 'error', msg);
  return new HttpError(500, 'internal', 'Internal error');
}

/**
 * State-changing calls are two-step: `{ dryRun: true }` returns the guard's own summary and
 * cost (shown in the app's confirmation dialog), then `{ confirm: true }` executes once.
 * Exactly one of the two is accepted. (Claiming rewards spends nothing: the app sends
 * confirm directly, like the CLI, still through the guard.)
 */
function guardOpts(body: unknown): GuardOptions {
  const b = (body ?? {}) as { dryRun?: unknown; confirm?: unknown };
  const dry = b.dryRun === true;
  const confirm = b.confirm === true;
  if (dry === confirm) throw new HttpError(400, 'bad_request', 'Send either { "dryRun": true } to preview or { "confirm": true } after the user confirmed');
  return confirm ? { assumeYes: true } : { dryRun: true };
}

function outcome<T>(o: GuardOutcome<T>, map: (r: T) => unknown): unknown {
  if (o.status === 'dry-run') return { status: 'dry-run', summary: o.summary, cost: o.cost };
  return { status: 'succeeded', actionId: o.action.id, result: map(o.result) };
}

const int = (v: string | null, name: string, min = 1, max = Number.MAX_SAFE_INTEGER): number | undefined => {
  if (v === null || v === '') return undefined;
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) throw new HttpError(400, 'bad_request', `${name} must be an integer ${min}..${max}`);
  return n;
};

/**
 * The local API used by the web app. It exposes the bot's modules (with their guards),
 * never Kyara directly, never credentials.
 */
export class AppApi {
  private routes: Array<{ method: string; re: RegExp; keys: string[]; fn: Handler }> = [];
  private charactersEtag: { etag: string; count: number; at: number } | null = null;

  constructor(
    private readonly bot: KyaraBot,
    private readonly bridge: BridgeService,
    private readonly monitors: MonitorService,
    private readonly hub: EventHub,
    private readonly startedAt: string,
    private readonly version: string,
  ) {
    this.register();
  }

  async handle(req: ApiRequest): Promise<ApiResult> {
    for (const r of this.routes) {
      if (r.method !== req.method) continue;
      const m = r.re.exec(req.path);
      if (!m) continue;
      try {
        const params = Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1] ?? '')]));
        const body = await r.fn(req, params);
        return req.path === '/characters' ? { body, etag: this.catalogueEtag(body as unknown[]) } : { body };
      } catch (err) {
        const h = toHttpError(err);
        if (h.status >= 500 && h.code === 'internal') this.bot.log.error(`Unhandled error on ${req.method} ${req.path}`, { error: (err as Error)?.message });
        throw h;
      }
    }
    throw new HttpError(404, 'not_found', `No route ${req.method} ${req.path}`);
  }

  /** Content hash of the catalogue, recomputed when it may have changed. */
  private catalogueEtag(list: unknown[]): string {
    const c = this.charactersEtag;
    if (c && c.count === list.length && Date.now() - c.at < 10 * 60_000) return c.etag;
    const etag = `"${createHash('sha1').update(JSON.stringify(list)).digest('base64url').slice(0, 22)}"`;
    this.charactersEtag = { etag, count: list.length, at: Date.now() };
    return etag;
  }

  private on(method: string, pattern: string, fn: Handler): void {
    const keys: string[] = [];
    const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_m, k: string) => (keys.push(k), '([^/]+)')) + '$');
    this.routes.push({ method, re, keys, fn });
  }

  private register(): void {
    const b = this.bot;

    // ---- system
    this.on('GET', '/status', async () => {
      const session = await b.session.status(false);
      const pass = session.passValidForMs;
      let site: { ok: boolean; catalogSize: number | null; error: string | null };
      try {
        const h = await b.api.catalog.health();
        site = { ok: h.ok, catalogSize: h.catalog?.size ?? null, error: null };
      } catch (err) {
        site = { ok: false, catalogSize: null, error: toHttpError(err).message };
      }
      return {
        server: { version: this.version, startedAt: this.startedAt, transport: b.http.transportName },
        session: {
          hasToken: session.hasToken,
          source: session.source,
          savedAt: session.savedAt,
          user: session.user ? { id: session.user.id, pseudo: session.user.pseudo, discordLinked: session.user.discordLinked } : null,
          problem: session.problem,
          passValidForMs: pass,
        },
        bridge: { clients: this.bridge.clients(), pairing: this.bridge.pairingPending() },
        site,
        rateLimit: b.http.rateLimit,
        automation: { pausedAll: this.monitors.isPausedAll, autoBidAllowedByConfig: b.config.autoBid.enabled, autoTradeAllowedByConfig: b.config.autoTrade.enabled, autoTradeBudget: b.config.autoTrade.budget, maxSpendPerAction: b.config.maxSpendPerAction },
      };
    });
    this.on('POST', '/session/forget', async () => {
      await this.monitors.pauseAll();
      await b.session.forget();
      return { ok: true, pausedAll: true };
    });
    this.on('POST', '/session/verify', async () => {
      const s = await b.session.status(true);
      return { valid: s.valid, problem: s.problem, user: s.user ? { pseudo: s.user.pseudo, chakra: s.user.chakra } : null };
    });
    this.on('POST', '/bridge/pairing-code', async () => this.bridge.createPairingCode());
    this.on('DELETE', '/bridge/pairing-code', async () => (this.bridge.cancelPairing(), { ok: true }));
    this.on('DELETE', '/bridge/clients/:id', async (_r, p) => {
      if (!this.bridge.unpair(p.id!)) throw new HttpError(404, 'not_found', 'Unknown client');
      return { ok: true };
    });
    this.on('GET', '/events', async (r) => this.hub.recentEvents(int(r.query.get('limit'), 'limit', 1, 300) ?? 100, r.query.get('type') ?? undefined));
    this.on('GET', '/logs', async (r) => this.hub.recentLogs(int(r.query.get('limit'), 'limit', 1, 600) ?? 300));

    // ---- account
    this.on('GET', '/me', async () => {
      const me = await b.account.me();
      const wallet = await b.account.wallet(me);
      return {
        profile: { id: me.id, pseudo: me.pseudo ?? null, discordLinked: !!me.discord, createdAt: me.createdAt ?? null, boostersOpened: me.boostersOpened ?? null },
        wallet,
      };
    });

    // ---- catalogue
    this.on('GET', '/characters', async () => b.characters.all());
    this.on('GET', '/characters/:id', async (_r, p) => b.characters.detail(int(p.id!, 'id')!));
    this.on('GET', '/series', async () => b.characters.seriesSummary());

    // ---- collection
    this.on('GET', '/collection', async () => {
      const entries = await b.collection.raw();
      const stats = await b.collection.stats(entries);
      return { entries, stats };
    });
    this.on('GET', '/wishlist', async () => b.api.account.wishlist());

    // ---- packs
    this.on('GET', '/packs', async () => {
      const loggedIn = b.http.hasToken();
      const [me, state] = loggedIn ? await Promise.all([b.account.me(), b.account.packState()]) : [null, null];
      const views = await b.packs.withAccess(me, state);
      return {
        loggedIn,
        chakra: me?.chakra ?? null,
        passValidForMs: (await b.session.status(false)).passValidForMs,
        passRequired: await b.passes.passRequired().catch(() => true),
        packs: views.map((v) => ({ ...v, affordable: v.access ? v.access.chakra <= (me?.chakra ?? 0) : null })),
      };
    });
    this.on('GET', '/packs/:id/rates', async (_r, p) => b.packs.rates(p.id));
    this.on('GET', '/packs/:id/pool', async (_r, p) => b.api.catalog.packCharacterIds(p.id!));
    this.on('POST', '/packs/:id/open', async (r, p) => {
      const body = z.object({ count: z.number().int().min(1).max(10) }).loose().safeParse(r.body);
      if (!body.success) throw new HttpError(400, 'bad_request', 'count must be 1..10');
      const out = await b.packs.open(p.id!, body.data.count, guardOpts(r.body));
      return outcome(out, (res) => res);
    });
    this.on('GET', '/packs/history', async () =>
      b.journal.list({ limit: 50 }).filter((a) => a.kind === 'pack.open'),
    );

    // ---- market
    this.on('GET', '/market/listings', async (r) => {
      const q = r.query;
      const query = ListingQuerySchema.parse({
        q: q.get('q') || undefined,
        rarity: q.get('rarity') || undefined,
        series: q.get('series') || undefined,
        type: q.get('type') || undefined,
        characterId: int(q.get('characterId'), 'characterId'),
        sort: q.get('sort') ?? 'ending',
        page: int(q.get('page'), 'page') ?? 1,
        pageSize: int(q.get('pageSize'), 'pageSize', 1, LISTING_MAX_PAGE_SIZE) ?? 24,
      });
      return b.market.search(query);
    });
    this.on('GET', '/market/listings/:id', async (_r, p) => b.market.listing(p.id!));
    this.on('GET', '/market/prices/:cid', async (_r, p) => b.market.prices(int(p.cid!, 'characterId')!));
    this.on('GET', '/market/orders/:cid', async (_r, p) => b.market.orderBook(int(p.cid!, 'characterId')!));
    this.on('GET', '/market/mine', async () => b.api.market.mine());
    this.on('GET', '/market/access', async () => b.api.market.access());
    this.on('POST', '/market/listings/:id/bid', async (r, p) => {
      const body = z.object({ maxAmount: z.number().int().positive() }).loose().safeParse(r.body);
      if (!body.success) throw new HttpError(400, 'bad_request', 'maxAmount must be a positive integer');
      const out = await b.market.bid(p.id!, body.data.maxAmount, guardOpts(r.body));
      return outcome(out, (res) => ({ leading: res.leading, currentBid: res.listing.currentBid ?? null, chakra: res.user.chakra }));
    });
    this.on('POST', '/market/listings/:id/buy', async (r, p) => {
      const body = z.object({ maxPrice: z.number().int().positive().optional() }).loose().safeParse(r.body);
      if (!body.success) throw new HttpError(400, 'bad_request', 'maxPrice must be a positive integer');
      const out = await b.market.buy(p.id!, { ...guardOpts(r.body), maxPrice: body.data.maxPrice });
      return outcome(out, (res) => ({ chakra: res.user.chakra }));
    });

    // ---- settings (spending limits; .env values stay locked)
    this.on('GET', '/settings', async () => b.settings.view());
    this.on('PUT', '/settings', async (r) => {
      const body = z.object({ settings: SettingsSchema, confirm: z.boolean().optional() }).safeParse(r.body);
      if (!body.success) throw new HttpError(400, 'bad_request', body.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
      const raises = b.settings.raises(body.data.settings);
      // letting the bot spend more always needs an explicit confirmation
      if (raises.length && body.data.confirm !== true) throw new HttpError(409, 'confirm_required', `Confirm to raise: ${raises.join(', ')}`);
      const view = b.settings.update(body.data.settings);
      await this.monitors.restartRunning();
      this.hub.publish({ type: 'settings.changed', level: raises.length ? 'warn' : 'info', title: raises.length ? 'Spending limits raised' : 'Settings saved', detail: raises.join(', ') || undefined });
      return view;
    });

    // ---- trades
    this.on('GET', '/trades', async () => ({ ...(await b.trades.mine()), botTradeIds: this.monitors.botTradeIds() }));
    this.on('POST', '/trades/:id/cancel', async (r, p) => outcome(await b.trades.cancel(p.id!, guardOpts(r.body)), () => ({ cancelled: true })));

    // ---- progress
    this.on('GET', '/progress', async () => b.progress.get());
    this.on('POST', '/progress/claim', async (r) => {
      const body = z.object({ kind: z.enum(CLAIM_KINDS).default('all'), id: z.string().max(120).optional() }).loose().safeParse(r.body);
      if (!body.success) throw new HttpError(400, 'bad_request', 'invalid claim');
      const out = await b.progress.claim(body.data.kind, body.data.id, guardOpts(r.body));
      return outcome(out, (res) => ({ gained: res.gained, chakra: res.user.chakra, claimable: res.progress.claimable }));
    });

    // ---- community (public)
    this.on('GET', '/feed', async () => b.api.catalog.feed());
    this.on('GET', '/leaderboard', async (r) => {
      return b.api.catalog.ladder(z.enum(LADDER_KEYS).parse(r.query.get('by') ?? 'collection'));
    });
    this.on('GET', '/config', async () => b.account.config());

    // ---- action journal
    this.on('GET', '/actions', async (r) => b.journal.list({ limit: int(r.query.get('limit'), 'limit', 1, 500) ?? 100 }));
    this.on('POST', '/actions/:id/resolve', async (r, p) => {
      const body = z.object({ as: z.enum(['succeeded', 'failed']) }).safeParse(r.body);
      if (!body.success) throw new HttpError(400, 'bad_request', 'as must be succeeded or failed');
      const rec = b.journal.get(p.id!);
      if (!rec) throw new HttpError(404, 'not_found', 'Unknown action');
      if (rec.status !== 'unknown' && rec.status !== 'pending') throw new HttpError(409, 'refused', `Action is already ${rec.status}`);
      return b.journal.finish(rec.id, body.data.as, { resolvedBy: 'user', error: rec.error ?? undefined });
    });

    // ---- automation
    this.on('GET', '/monitors', async () => ({ pausedAll: this.monitors.isPausedAll, monitors: this.monitors.list() }));
    this.on('POST', '/monitors', async (r) => this.monitors.create(r.body));
    this.on('PUT', '/monitors/:id', async (r, p) => this.monitors.update(p.id!, r.body));
    this.on('DELETE', '/monitors/:id', async (_r, p) => (await this.monitors.remove(p.id!), { ok: true }));
    this.on('POST', '/monitors/:id/enable', async (_r, p) => this.monitors.setEnabled(p.id!, true));
    this.on('POST', '/monitors/:id/disable', async (_r, p) => this.monitors.setEnabled(p.id!, false));
    this.on('POST', '/automation/pause', async () => (await this.monitors.pauseAll(), { pausedAll: true }));
    this.on('POST', '/automation/resume', async () => (this.monitors.resumeAll(), { pausedAll: false }));
  }
}
