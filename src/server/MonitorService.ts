import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { KyaraBot } from '../bot.js';
import { AccountWatcher } from '../services/AccountWatcher.js';
import type { AuctionProgress } from '../services/AuctionMonitor.js';
import { AuctionMonitor } from '../services/AuctionMonitor.js';
import { poll } from '../services/Poller.js';
import type { TradeProgress } from '../services/TradeMonitor.js';
import { TradeMonitor } from '../services/TradeMonitor.js';
import { AuthRequiredError } from '../utils/errors.js';
import type { EventHub } from './EventHub.js';
import { HubNotifier } from './EventHub.js';
import { HttpError } from './http.js';

/** Floors that the UI cannot lower (same as the CLI). */
export const MIN_INTERVAL_SEC = { auctions: 30, account: 120, trades: 60 } as const;

const RarityEnum = z.enum(['C', 'U', 'R', 'E', 'L', 'M']);

const AuctionParams = z
  .object({
    q: z.string().trim().max(80).optional(),
    rarity: z.enum(['C', 'U', 'R', 'E', 'L', 'M']).optional(),
    series: z.string().trim().max(80).optional(),
    characterId: z.number().int().positive().optional(),
    type: z.enum(['auction', 'fixed']).optional(),
    maxPrice: z.number().int().positive().optional(),
    endingSoonSec: z.number().int().min(0).max(86_400).default(300),
    pages: z.number().int().min(1).max(5).default(1),
    autoBid: z
      .object({
        enabled: z.boolean().default(false),
        /** 0 = copies x maximum. */
        budget: z.number().int().min(0).default(0),
        /** 0 = the monitor's maximum price. */
        maxBid: z.number().int().min(0).default(0),
        withinSec: z.number().int().min(10).max(3600).default(120),
        copies: z.number().int().min(1).max(50).default(1),
      })
      .default({ enabled: false, budget: 0, maxBid: 0, withinSec: 120, copies: 1 }),
  })
  .strict();

const AccountParams = z
  .object({
    autoClaim: z.boolean().default(false),
    autoOpenFreePack: z.string().max(60).nullable().default(null),
  })
  .strict();

const pct = (min: number, max: number, def: number) => z.number().int().min(min).max(max).default(def);

export const TRADE_DEFAULTS = {
  give: { keep: 0, rarities: [] as Array<z.infer<typeof RarityEnum>>, exclude: [] as number[] },
  seek: { enabled: true, wishMinPct: 80, wishMaxPct: 130, allowChakra: true, markupPct: 110 },
  offer: { enabled: true, payWithCards: true, payWithChakra: true, minPayPct: 80, maxPayPct: 110, maxChakra: 200, maxCards: 3, onlyMissing: true },
  limits: { maxPending: 3, maxPerHour: 5, perUserHours: 24, expireMin: 30, budget: 0 },
};

const TradeParams = z
  .object({
    mode: z.enum(['preview', 'auto']).default('preview'),
    rooms: z.array(z.number().int().min(1).max(99)).max(99).nullable().default(null),
    maxAgeMin: z.number().int().min(1).max(120).default(10),
    message: z.string().max(200).default('Hi {pseudo}! Saw your {name} in the market chat.'),
    give: z
      .object({ keep: z.number().int().min(0).max(50).default(0), rarities: z.array(RarityEnum).max(6).default([]), exclude: z.array(z.number().int().positive()).max(500).default([]) })
      .default(TRADE_DEFAULTS.give),
    seek: z
      .object({ enabled: z.boolean().default(true), wishMinPct: pct(10, 500, 80), wishMaxPct: pct(10, 500, 130), allowChakra: z.boolean().default(true), markupPct: pct(50, 300, 110) })
      .default(TRADE_DEFAULTS.seek),
    offer: z
      .object({
        enabled: z.boolean().default(true),
        payWithCards: z.boolean().default(true),
        payWithChakra: z.boolean().default(true),
        minPayPct: pct(10, 300, 80),
        maxPayPct: pct(10, 300, 110),
        maxChakra: z.number().int().min(0).max(10_000_000).default(200),
        maxCards: z.number().int().min(1).max(5).default(3),
        onlyMissing: z.boolean().default(true),
      })
      .default(TRADE_DEFAULTS.offer),
    limits: z
      .object({
        maxPending: z.number().int().min(1).max(20).default(3),
        maxPerHour: z.number().int().min(1).max(60).default(5),
        perUserHours: z.number().int().min(1).max(168).default(24),
        expireMin: z.number().int().min(5).max(2880).default(30),
        budget: z.number().int().min(0).max(10_000_000).default(0),
      })
      .default(TRADE_DEFAULTS.limits),
  })
  .strict()
  .refine((p) => p.seek.wishMinPct <= p.seek.wishMaxPct && p.offer.minPayPct <= p.offer.maxPayPct, 'Minimum percentages must not exceed maximums');

const Base = { name: z.string().trim().min(1).max(60), enabled: z.boolean().default(false), intervalSec: z.number().int().max(86_400) };
export const MonitorInputSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('auctions'), ...Base, params: AuctionParams }).strict(),
  z.object({ kind: z.literal('account'), ...Base, params: AccountParams }).strict(),
  z.object({ kind: z.literal('trades'), ...Base, params: TradeParams }).strict(),
]);
export type MonitorInput = z.infer<typeof MonitorInputSchema>;
export type MonitorConfig = MonitorInput & { id: string; createdAt: string; updatedAt: string };

const FileSchema = z.object({ version: z.literal(1), pausedAll: z.boolean(), monitors: z.array(z.any()), progress: z.record(z.string(), z.any()).optional() });

export type MonitorState = 'running' | 'stopped' | 'paused' | 'error' | 'needs-session';

export interface RunRecord {
  at: string;
  ok: boolean;
  ms: number;
  error?: string;
}

export interface MonitorStatus {
  state: MonitorState;
  startedAt: string | null;
  lastRunAt: string | null;
  lastOkAt: string | null;
  lastError: string | null;
  ticks: number;
  /** Chakra reserved by this monitor's auto-bids since it started. */
  reserved: number;
  /** Effective auto-bid after the global setting (Settings or .env), or null when off. */
  autoBid: { budget: number; maxBid: number; copies: number } | null;
  /** Copies won and currently led by this monitor's bids (persisted across restarts). */
  copies: { won: number; leading: number; target: number | null } | null;
  /** Set after an unclear bid outcome; saving the monitor again clears it. */
  autoBidHalted: boolean;
  autoBidBlockedReason: string | null;
  /** Trade monitors: effective mode and what they did (persisted across restarts). */
  trades: { mode: 'preview' | 'auto'; pending: number; sent: number; accepted: number; declined: number; expired: number; halted: boolean } | null;
  /** Why a trade monitor set to auto only previews. */
  tradeBlockedReason: string | null;
  history: RunRecord[];
}

interface Runtime {
  ac: AbortController;
  done: Promise<void>;
  status: MonitorStatus;
  auction?: AuctionMonitor;
  trade?: TradeMonitor;
}

/**
 * Runs the monitors (AuctionMonitor, AccountWatcher, TradeMonitor) inside the server process,
 * with persisted configuration and progress. A monitor shows "running" only while its loop
 * is alive.
 */
export class MonitorService {
  private monitors: MonitorConfig[] = [];
  private pausedAll = false;
  private runtimes = new Map<string, Runtime>();
  private statuses = new Map<string, MonitorStatus>();
  private progress = new Map<string, AuctionProgress | TradeProgress>();

  constructor(
    private readonly bot: KyaraBot,
    private readonly hub: EventHub,
    private readonly file: string,
  ) {
    this.load();
  }

  list(): Array<MonitorConfig & { status: MonitorStatus }> {
    return this.monitors.map((m) => ({ ...m, status: this.statusOf(m) }));
  }

  /** Trades proposed by trade monitors (to badge them in the UI). */
  botTradeIds(): string[] {
    const ids = new Set<string>();
    for (const [id, pr] of this.progress) {
      const live = this.runtimes.get(id)?.trade?.progress ?? pr;
      if ('sent' in live) for (const s of live.sent) if (s.tradeId) ids.add(s.tradeId);
    }
    return [...ids];
  }

  get isPausedAll(): boolean {
    return this.pausedAll;
  }

  create(input: unknown): MonitorConfig {
    const parsed = this.validate(input);
    const now = new Date().toISOString();
    const m: MonitorConfig = { ...parsed, id: randomUUID(), createdAt: now, updatedAt: now };
    this.monitors.push(m);
    this.save();
    this.reconcile(m);
    return m;
  }

  async update(id: string, input: unknown): Promise<MonitorConfig> {
    const i = this.monitors.findIndex((m) => m.id === id);
    if (i < 0) throw new HttpError(404, 'not_found', 'Unknown monitor');
    const prev = this.monitors[i]!;
    const parsed = this.validate(input);
    const next: MonitorConfig = { ...parsed, id, createdAt: prev.createdAt, updatedAt: new Date().toISOString() };
    this.monitors[i] = next;
    const kept = this.progress.get(id);
    if (kept) {
      // copies won count toward the target until the monitor watches something else
      if (watchKey(prev) !== watchKey(next)) this.progress.delete(id);
      else this.progress.set(id, { ...kept, halted: false } as AuctionProgress | TradeProgress);
    }
    this.save();
    // the old loop (and any tick in flight) ends before the new one starts: no double budget
    await this.stop(id);
    this.reconcile(next);
    return next;
  }

  async remove(id: string): Promise<void> {
    await this.stop(id);
    const before = this.monitors.length;
    this.monitors = this.monitors.filter((m) => m.id !== id);
    if (before === this.monitors.length) throw new HttpError(404, 'not_found', 'Unknown monitor');
    this.statuses.delete(id);
    this.progress.delete(id);
    this.save();
  }

  async setEnabled(id: string, enabled: boolean): Promise<MonitorConfig> {
    const m = this.monitors.find((x) => x.id === id);
    if (!m) throw new HttpError(404, 'not_found', 'Unknown monitor');
    m.enabled = enabled;
    m.updatedAt = new Date().toISOString();
    this.save();
    if (enabled) this.reconcile(m);
    else await this.stop(id);
    return m;
  }

  /** Kill switch: stops every loop immediately and keeps them stopped until resumed. */
  async pauseAll(): Promise<void> {
    this.pausedAll = true;
    this.save();
    // every monitor checks isActive() before spending, so nothing is spent from here on
    await Promise.all([...this.runtimes.keys()].map((id) => this.stop(id)));
    this.hub.publish({ type: 'automation.paused', level: 'warn', title: 'All automation paused' });
  }

  resumeAll(): void {
    this.pausedAll = false;
    this.save();
    for (const m of this.monitors) this.reconcile(m);
    this.hub.publish({ type: 'automation.resumed', level: 'info', title: 'Automation resumed' });
  }

  /** Restarts running monitors so they pick up changed limits (in-app settings). */
  async restartRunning(): Promise<void> {
    const ids = [...this.runtimes.keys()];
    await Promise.all(ids.map((id) => this.stop(id)));
    for (const m of this.monitors) if (ids.includes(m.id)) this.reconcile(m);
  }

  startEnabled(): void {
    for (const m of this.monitors) this.reconcile(m);
  }

  async shutdown(): Promise<void> {
    await Promise.allSettled([...this.runtimes.keys()].map((id) => this.stop(id)));
  }

  private validate(input: unknown): MonitorInput {
    const parsed = MonitorInputSchema.safeParse(input);
    if (!parsed.success) {
      throw new HttpError(400, 'bad_request', parsed.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; '));
    }
    const m = parsed.data;
    const floor = MIN_INTERVAL_SEC[m.kind];
    if (m.intervalSec < floor) throw new HttpError(400, 'bad_request', `intervalSec must be at least ${floor} for ${m.kind} monitors`);
    if (m.kind === 'auctions' && m.params.autoBid.enabled && !m.params.maxPrice) {
      throw new HttpError(400, 'bad_request', 'Auto-bid requires a maximum price');
    }
    return m;
  }

  /** The global auto-bid setting (Settings or .env) always wins over the monitor's own. */
  private effectiveAutoBid(m: MonitorConfig): { value: { budget: number; maxBid: number; copies: number } | null; blocked: string | null } {
    if (m.kind !== 'auctions' || !m.params.autoBid.enabled) return { value: null, blocked: null };
    const env = this.bot.config.autoBid;
    if (!env.enabled) return { value: null, blocked: 'Automatic bidding is off in Settings' };
    if (env.budget <= 0 || env.maxBid <= 0) return { value: null, blocked: 'The bidding budget or maximum per copy is 0 in Settings' };
    const ab = m.params.autoBid;
    const maxBid = Math.min(ab.maxBid || Infinity, env.maxBid, m.params.maxPrice ?? Infinity);
    const budget = Math.min(ab.budget || ab.copies * maxBid, env.budget);
    if (!Number.isFinite(maxBid) || budget <= 0 || maxBid <= 0) return { value: null, blocked: 'Budget or maximum bid is 0' };
    if (budget < maxBid) return { value: null, blocked: `The budget (${budget}) is below one maximum bid (${maxBid})` };
    return { value: { budget, maxBid, copies: ab.copies }, blocked: null };
  }

  /** Trade monitors send only when Settings (or .env) allow it; otherwise they run in preview. */
  private effectiveTrade(m: MonitorConfig): { mode: 'preview' | 'auto'; budget: number; blocked: string | null } | null {
    if (m.kind !== 'trades') return null;
    const env = this.bot.config.autoTrade;
    if (m.params.mode !== 'auto') return { mode: 'preview', budget: 0, blocked: null };
    if (!env.enabled) return { mode: 'preview', budget: 0, blocked: 'Sending trades is off in Settings, so this monitor only previews' };
    return { mode: 'auto', budget: Math.min(m.params.limits.budget, env.budget), blocked: null };
  }

  private statusOf(m: MonitorConfig): MonitorStatus {
    const rt = this.runtimes.get(m.id);
    const st = rt?.status ?? this.statuses.get(m.id) ?? this.blankStatus(m);
    const ab = this.effectiveAutoBid(m);
    const state: MonitorState = rt ? st.state : this.pausedAll && m.enabled ? 'paused' : st.state === 'error' || st.state === 'needs-session' ? st.state : 'stopped';
    const pr = m.kind === 'auctions' ? (this.progress.get(m.id) as AuctionProgress | undefined) : undefined;
    const held = (p: AuctionProgress) => p.won.reduce((a, w) => a + w.price, 0) + p.tracked.filter((t) => t.leading !== false).reduce((a, t) => a + t.amount, 0);
    const copies =
      m.kind !== 'auctions'
        ? null
        : rt?.auction
          ? rt.auction.copies
          : { won: pr?.won.length ?? 0, leading: pr?.tracked.filter((t) => t.leading !== false).length ?? 0, target: ab.value?.copies ?? null };
    const reserved = rt?.auction?.reservedChakra ?? (pr ? held(pr) : st.reserved);
    const tr = this.effectiveTrade(m);
    const tp = rt?.trade?.progress ?? (m.kind === 'trades' ? (this.progress.get(m.id) as TradeProgress | undefined) : undefined);
    const trades = tr
      ? { mode: tr.mode, pending: tp?.sent.filter((s) => s.status === 'pending').length ?? 0, sent: tp?.stats.sent ?? 0, accepted: tp?.stats.accepted ?? 0, declined: tp?.stats.declined ?? 0, expired: tp?.stats.expired ?? 0, halted: tp?.halted ?? false }
      : null;
    return { ...st, state, reserved, autoBid: ab.value, autoBidBlockedReason: ab.blocked, copies, autoBidHalted: rt?.auction?.progress.halted ?? pr?.halted ?? false, trades, tradeBlockedReason: tr?.blocked ?? null };
  }

  private blankStatus(m: MonitorConfig): MonitorStatus {
    return { state: 'stopped', startedAt: null, lastRunAt: null, lastOkAt: null, lastError: null, ticks: 0, reserved: 0, autoBid: null, autoBidBlockedReason: this.effectiveAutoBid(m).blocked, copies: null, autoBidHalted: false, trades: null, tradeBlockedReason: null, history: [] };
  }

  private reconcile(m: MonitorConfig): void {
    if (!m.enabled || this.pausedAll || this.runtimes.has(m.id)) return;
    if ((m.kind === 'account' || m.kind === 'trades') && !this.bot.http.hasToken()) {
      this.statuses.set(m.id, { ...this.blankStatus(m), state: 'needs-session', lastError: 'Needs a Kyara session' });
      return;
    }
    const status: MonitorStatus = { ...this.blankStatus(m), state: 'running', startedAt: new Date().toISOString(), history: this.statuses.get(m.id)?.history ?? [] };
    const ac = new AbortController();
    const notifier = new HubNotifier(this.hub, { monitorId: m.id, monitor: m.name });
    const log = this.bot.log.child(`monitor:${m.name}`);
    let tick: () => Promise<number | undefined>;
    let auction: AuctionMonitor | undefined;
    let trade: TradeMonitor | undefined;
    if (m.kind === 'trades') {
      const p = m.params;
      const eff = this.effectiveTrade(m)!;
      let chars: Map<number, { name: string; rarity: string }> | null = null;
      trade = new TradeMonitor(this.bot.api, this.bot.account, this.bot.trades, notifier, log, {
        rules: { give: p.give, seek: p.seek, offer: p.offer },
        limits: { maxPending: p.limits.maxPending, maxPerHour: p.limits.maxPerHour, perUserMs: p.limits.perUserHours * 3600_000, expireMs: p.limits.expireMin * 60_000, budget: eff.budget },
        mode: eff.mode,
        rooms: p.rooms,
        maxAgeMs: p.maxAgeMin * 60_000,
        message: p.message,
        nameOf: (id) => chars?.get(id)?.name,
        rarityOf: (id) => chars?.get(id)?.rarity,
        isActive: () => !ac.signal.aborted,
        progress: this.progress.get(m.id) as TradeProgress | undefined,
        onProgress: (pr) => {
          this.progress.set(m.id, pr);
          this.save();
        },
      });
      tick = async () => {
        // names and rarities for summaries and the "rarities I give" rule (cached catalogue)
        chars ??= await this.bot.characters.byIds();
        return trade!.tick();
      };
    } else if (m.kind === 'auctions') {
      const p = m.params;
      const ab = this.effectiveAutoBid(m).value;
      auction = new AuctionMonitor(this.bot.market, notifier, log, {
        query: { q: p.q, rarity: p.rarity, series: p.series, characterId: p.characterId, type: p.type, sort: 'ending', pageSize: 50 },
        filter: { maxPrice: p.maxPrice, excludeMine: true },
        endingSoonMs: p.endingSoonSec * 1000,
        maxPages: p.pages,
        autoBid: ab ? { enabled: true, budget: ab.budget, maxBid: ab.maxBid, onlyWithinMs: p.autoBid.withinSec * 1000, copies: ab.copies } : undefined,
        isActive: () => !ac.signal.aborted,
        progress: this.progress.get(m.id) as AuctionProgress | undefined,
        onProgress: (pr) => {
          this.progress.set(m.id, pr);
          this.save();
        },
      });
      tick = () => auction!.tick();
    } else {
      const watcher = new AccountWatcher(this.bot.account, this.bot.progress, this.bot.packs, notifier, log, {
        autoClaim: m.params.autoClaim,
        autoOpenFreePack: m.params.autoOpenFreePack,
        isActive: () => !ac.signal.aborted,
      });
      tick = () => watcher.tick();
    }

    const record = async (): Promise<number | undefined> => {
      const started = Date.now();
      status.lastRunAt = new Date().toISOString();
      try {
        const next = await tick();
        status.ticks++;
        status.lastOkAt = new Date().toISOString();
        status.lastError = null;
        push(status, { at: status.lastRunAt, ok: true, ms: Date.now() - started });
        return next;
      } catch (err) {
        status.ticks++;
        status.lastError = (err as Error).message;
        push(status, { at: status.lastRunAt, ok: false, ms: Date.now() - started, error: status.lastError });
        throw err;
      }
    };

    const done = poll(record, {
      intervalMs: m.intervalSec * 1000,
      minIntervalMs: MIN_INTERVAL_SEC[m.kind] * 1000,
      maxDurationMs: 7 * 24 * 3600_000,
      signal: ac.signal,
      log,
    })
      .then((r) => {
        status.state = 'stopped';
        log.info(`stopped (${r.reason})`);
      })
      .catch((err: unknown) => {
        status.state = err instanceof AuthRequiredError ? 'needs-session' : 'error';
        status.lastError = (err as Error).message;
        this.hub.publish({ type: 'monitor.error', level: 'error', title: `${m.name} stopped`, detail: status.lastError, data: { monitorId: m.id } });
      })
      .finally(() => {
        status.reserved = auction?.reservedChakra ?? status.reserved;
        this.statuses.set(m.id, { ...status });
        if (this.runtimes.get(m.id)?.ac === ac) this.runtimes.delete(m.id);
      });

    this.runtimes.set(m.id, { ac, done, status, auction, trade });
    this.hub.publish({ type: 'monitor.started', level: 'info', title: `${m.name} started`, data: { monitorId: m.id } });
  }

  /** Aborts the loop and waits for a tick in flight to end. */
  private async stop(id: string): Promise<void> {
    const rt = this.runtimes.get(id);
    if (!rt) return;
    rt.ac.abort();
    const done = rt.done;
    rt.status.state = 'stopped';
    this.statuses.set(id, { ...rt.status });
    this.runtimes.delete(id);
    this.hub.publish({ type: 'monitor.stopped', level: 'info', title: `${this.monitors.find((m) => m.id === id)?.name ?? 'Monitor'} stopped`, data: { monitorId: id } });
    await done.catch(() => undefined);
  }

  private load(): void {
    if (!fs.existsSync(this.file)) return;
    try {
      const raw = FileSchema.parse(JSON.parse(fs.readFileSync(this.file, 'utf8')));
      this.pausedAll = raw.pausedAll;
      for (const [id, pr] of Object.entries(raw.progress ?? {})) {
        if (pr && Array.isArray(pr.won) && Array.isArray(pr.tracked)) this.progress.set(id, { won: pr.won, tracked: pr.tracked, halted: !!pr.halted });
        else if (pr && Array.isArray(pr.sent) && pr.stats && pr.lastSeen) this.progress.set(id, { lastSeen: pr.lastSeen, sent: pr.sent, stats: pr.stats, halted: !!pr.halted });
      }
      for (const m of raw.monitors) {
        const parsed = MonitorInputSchema.safeParse({ kind: m.kind, name: m.name, enabled: m.enabled, intervalSec: m.intervalSec, params: m.params });
        if (parsed.success) this.monitors.push({ ...parsed.data, id: String(m.id), createdAt: String(m.createdAt), updatedAt: String(m.updatedAt) });
      }
    } catch {
      this.bot.log.warn('monitors.json is unreadable; starting with no monitors');
    }
  }

  private save(): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ version: 1, pausedAll: this.pausedAll, monitors: this.monitors, progress: Object.fromEntries(this.progress) }, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }
}

/** What an auction monitor watches; won copies only carry over while this stays the same. */
function watchKey(m: MonitorConfig): string {
  if (m.kind === 'trades') return 'trades'; // the bot's proposals stay followed whatever the rules
  if (m.kind !== 'auctions') return m.kind;
  const { q, rarity, series, characterId, type } = m.params;
  return JSON.stringify([q ?? null, rarity ?? null, series ?? null, characterId ?? null, type ?? null]);
}

function push(s: MonitorStatus, r: RunRecord): void {
  s.history.unshift(r);
  if (s.history.length > 50) s.history.pop();
}
