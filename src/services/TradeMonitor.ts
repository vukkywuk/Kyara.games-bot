import type { ChatMessage, FairPlay, Trade } from '../api/schemas/trades.js';
import { ChatCardAttachmentSchema } from '../api/schemas/trades.js';
import type { AccountModule } from '../modules/AccountModule.js';
import type { TradeModule } from '../modules/TradeModule.js';
import type { TradeCards } from '../modules/tradeFairness.js';
import type { PlanContext, TradeRequest, TradeRules } from '../modules/tradePlanner.js';
import { idsToPrice, mayGive, planTrade, spareCopies } from '../modules/tradePlanner.js';
import type { KyaraApi } from '../api/KyaraApi.js';
import { ActionRefusedError, AmbiguousOutcomeError, HumanVerificationError, KyaraApiError } from '../utils/errors.js';
import type { Logger } from '../utils/logger.js';
import type { Notifier } from './Notifier.js';

export interface TradeLimits {
  /** Most of my proposals pending at once (all of them, not only the bot's). */
  maxPending: number;
  maxPerHour: number;
  /** One proposal per player within this window. */
  perUserMs: number;
  /** The bot cancels its own unanswered proposals after this long, unlocking the cards. */
  expireMs: number;
  /** Most chakra committed in the bot's pending proposals. */
  budget: number;
}

export interface SentTrade {
  tradeId: string | null;
  toUserId: string;
  pseudo: string;
  at: string;
  give: TradeCards;
  want: TradeCards;
  summary: string;
  status: string;
}

export interface TradeProgress {
  /** Newest chat message handled, per room. */
  lastSeen: Record<string, string>;
  sent: SentTrade[];
  stats: { sent: number; accepted: number; declined: number; expired: number; cancelled: number };
  halted: boolean;
}

export interface TradeMonitorOptions {
  rules: TradeRules;
  limits: TradeLimits;
  /** preview = say what would be sent; auto = send. */
  mode: 'preview' | 'auto';
  /** Chat rooms to read; null = all. */
  rooms: number[] | null;
  /** Ignore chat requests older than this. */
  maxAgeMs: number;
  /** Message sent with the trade; `{pseudo}` and `{name}` are replaced. Empty = none. */
  message: string;
  /** Requests looked at per check (each costs a few API calls). */
  maxPerTick?: number;
  nameOf?: (characterId: number) => string | undefined;
  rarityOf?: (characterId: number) => string | undefined;
  isActive?: () => boolean;
  progress?: TradeProgress;
  onProgress?: (p: TradeProgress) => void;
}

const HOUR = 3600_000;
const KEEP_SENT = 200;

export const emptyTradeProgress = (): TradeProgress => ({ lastSeen: {}, sent: [], stats: { sent: 0, accepted: 0, declined: 0, expired: 0, cancelled: 0 }, halted: false });

/**
 * Reads the market chat for structured trade requests (a card tagged "seek" or "trade") and
 * answers them with a trade proposal planned by `planTrade`: only spare copies, only trades the
 * site's fair-play check calls fair, within pending / hourly / per-player / budget limits.
 * It never posts in the chat, and never accepts or declines trades for you.
 */
export class TradeMonitor {
  private p: TradeProgress;
  private myId: string | null = null;
  private passWarned = false;

  constructor(
    private readonly api: KyaraApi,
    private readonly account: AccountModule,
    private readonly trades: TradeModule,
    private readonly notifier: Notifier,
    private readonly log: Logger,
    private readonly opts: TradeMonitorOptions,
  ) {
    const p = opts.progress ?? emptyTradeProgress();
    this.p = { lastSeen: { ...p.lastSeen }, sent: p.sent.map((s) => ({ ...s })), stats: { ...emptyTradeProgress().stats, ...p.stats }, halted: !!p.halted };
  }

  get progress(): TradeProgress {
    return { lastSeen: { ...this.p.lastSeen }, sent: this.p.sent.map((s) => ({ ...s })), stats: { ...this.p.stats }, halted: this.p.halted };
  }

  get pending(): number {
    return this.p.sent.filter((s) => s.status === 'pending').length;
  }

  async tick(now = Date.now()): Promise<undefined> {
    const before = JSON.stringify(this.p);
    const me = await this.account.me();
    this.myId = me.id;
    const mine = await this.trades.mine();
    await this.followUp(mine.outgoing, now);

    if (!this.p.halted && this.active()) {
      const requests = await this.readChat(now);
      if (requests.length) await this.answer(requests, mine.outgoing, me.chakra, now);
    }
    if (JSON.stringify(this.p) !== before) this.opts.onProgress?.(this.progress);
    return undefined;
  }

  private active(): boolean {
    return !this.opts.isActive || this.opts.isActive();
  }

  // ------------------------------------------------------------ my proposals

  /** Matches the bot's proposals with Kyara's list, reports outcomes and cancels stale ones. */
  private async followUp(outgoing: Trade[], now: number): Promise<void> {
    const taken = new Set(this.p.sent.map((s) => s.tradeId).filter(Boolean));
    for (const s of this.p.sent) {
      if (s.status !== 'pending') continue;
      if (!s.tradeId) {
        const match = outgoing.find((t) => !taken.has(t.id) && t.to.id === s.toUserId && Date.parse(t.createdAt) >= Date.parse(s.at) - 60_000 && sig(t.give) === sig(s.give) && sig(t.want) === sig(s.want));
        if (match) {
          s.tradeId = match.id;
          taken.add(match.id);
        }
      }
      const t = s.tradeId ? outgoing.find((x) => x.id === s.tradeId) : undefined;
      if (t && t.status !== 'pending') {
        this.settle(s, t.status);
        continue;
      }
      if (!t && now - Date.parse(s.at) > 50 * HOUR) {
        this.settle(s, 'expired');
        continue;
      }
      if (t && this.opts.mode === 'auto' && now - Date.parse(s.at) > this.opts.limits.expireMs && this.active()) {
        try {
          const out = await this.trades.cancel(t.id, { assumeYes: true });
          if (out.status === 'succeeded') {
            s.status = 'expired';
            this.p.stats.expired++;
            this.notifier.notify({ type: 'trade.expired', title: `No answer from ${s.pseudo}; trade cancelled`, detail: `${s.summary}. The cards are free again.`, data: { tradeId: t.id } });
          }
        } catch (err) {
          if (err instanceof ActionRefusedError || err instanceof KyaraApiError) this.log.info(`Could not cancel trade ${t.id.slice(0, 8)}: ${(err as Error).message}`);
          else throw err;
        }
      }
    }
    this.p.sent = this.p.sent.slice(-KEEP_SENT);
  }

  private settle(s: SentTrade, status: string): void {
    s.status = status;
    if (status === 'accepted') {
      this.p.stats.accepted++;
      this.notifier.notify({ type: 'trade.accepted', title: `${s.pseudo} accepted your trade`, detail: s.summary, data: { tradeId: s.tradeId } });
    } else if (status === 'declined') {
      this.p.stats.declined++;
      this.notifier.notify({ type: 'trade.declined', title: `${s.pseudo} declined your trade`, detail: s.summary, data: { tradeId: s.tradeId } });
    } else if (status === 'expired') {
      this.p.stats.expired++;
    } else {
      this.p.stats.cancelled++;
    }
  }

  // ------------------------------------------------------------ chat

  private async readChat(now: number): Promise<TradeRequest[]> {
    const rooms = this.opts.rooms ?? (await this.api.trades.chatRooms()).rooms.map((r) => r.room);
    const out = new Map<string, TradeRequest>();
    for (const room of rooms) {
      const page = await this.api.trades.chat(room, 50);
      const since = this.p.lastSeen[room] ? Date.parse(this.p.lastSeen[room]!) : -Infinity;
      let newest = since;
      for (const m of page.items) {
        const at = Date.parse(m.createdAt);
        newest = Math.max(newest, at);
        if (at <= since || now - at > this.opts.maxAgeMs) continue;
        const req = this.toRequest(m);
        if (req) out.set(`${req.kind}:${req.user.id}:${req.character.id}`, req);
      }
      if (Number.isFinite(newest)) this.p.lastSeen[room] = new Date(newest).toISOString();
    }
    return [...out.values()].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  }

  private toRequest(m: ChatMessage): TradeRequest | null {
    if (m.author.id === this.myId) return null;
    const a = ChatCardAttachmentSchema.safeParse(m.attachment);
    if (!a.success) return null;
    const kind = a.data.tag === 'seek' ? 'seek' : a.data.tag === 'trade' ? 'offer' : null;
    if (!kind) return null;
    const c = a.data.character;
    return { kind, messageId: m.id, room: m.room, at: m.createdAt, user: { id: m.author.id, pseudo: m.author.pseudo }, character: { id: c.id, name: c.name, rarity: c.rarity } };
  }

  // ------------------------------------------------------------ answering

  private async answer(requests: TradeRequest[], outgoing: Trade[], chakra: number, now: number): Promise<void> {
    const { rules, limits } = this.opts;
    const [collection, wishlistIds] = await Promise.all([this.api.account.collection(), this.api.account.wishlist()]);
    const wishlist = new Set(wishlistIds);
    const owned = new Set(collection.filter((e) => e.qty > 0).map((e) => e.characterId));
    const spare = new Map<number, number>();
    for (const e of collection) {
      const n = spareCopies(e, rules.give.keep);
      if (n > 0) spare.set(e.characterId, n);
    }
    const rarityOf = (id: number) => this.opts.rarityOf?.(id);
    const prices = new Map<number, number>();
    let pendingAll = outgoing.filter((t) => t.status === 'pending').length;
    let committed = this.p.sent.filter((s) => s.status === 'pending').reduce((a, s) => a + s.give.chakra, 0);

    let looked = 0;
    for (const req of requests) {
      if (!this.active() || this.p.halted) return;
      if (looked >= (this.opts.maxPerTick ?? 5)) break;
      if (this.opts.mode === 'auto' && pendingAll >= limits.maxPending) return void this.log.info(`Trade requests skipped: ${pendingAll} proposals already pending.`);
      if (this.opts.mode === 'auto' && this.p.sent.filter((s) => now - Date.parse(s.at) < HOUR).length >= limits.maxPerHour) return;
      if (this.p.sent.some((s) => s.toUserId === req.user.id && now - Date.parse(s.at) < limits.perUserMs)) continue;
      // cheap checks before spending API calls on this player
      if (req.kind === 'seek' && !mayGive(req.character.id, { spare, rarityOf }, rules.give)) continue;
      if (req.kind === 'offer' && (!wishlist.has(req.character.id) || (rules.offer.onlyMissing && owned.has(req.character.id)))) continue;
      if ((req.kind === 'seek' && !rules.seek.enabled) || (req.kind === 'offer' && !rules.offer.enabled)) continue;
      looked++;

      let fairPlay: FairPlay;
      let theirAvailable: Map<number, number>;
      let theirOwned: Set<number> | null;
      try {
        const [avail, fp, ownedBy] = await Promise.all([
          this.api.trades.available(req.user.id),
          this.api.trades.fairWith(req.user.id),
          req.kind === 'offer' && rules.offer.payWithCards ? this.api.trades.ownedBy(req.user.id) : Promise.resolve(null),
        ]);
        theirAvailable = new Map(avail.map((x) => [x.characterId, x.n]));
        fairPlay = fp;
        theirOwned = ownedBy ? new Set(ownedBy) : null;
      } catch (err) {
        if (err instanceof KyaraApiError) {
          this.log.info(`Skipped ${req.user.pseudo}: ${err.message}`);
          continue;
        }
        throw err;
      }
      const base = { spare, rarityOf, wishlist, theirAvailable };
      const need = idsToPrice(req, base, rules).filter((id) => !prices.has(id));
      for (let i = 0; i < need.length; i += 200) {
        const got = await this.api.trades.fairPrices(need.slice(i, i + 200));
        for (const [k, v] of Object.entries(got)) prices.set(Number(k), v);
      }
      const ctx: PlanContext = { ...base, owned, theirOwned, prices, fairPlay, chakraAvailable: Math.max(0, Math.min(chakra, limits.budget - committed)) };
      const plan = planTrade(req, ctx, rules);
      if (!plan.ok) {
        this.log.info(`No trade for ${req.user.pseudo} (${req.kind} ${req.character.name}): ${plan.reason}`);
        continue;
      }
      const summary = `${describe(plan.give, this.opts.nameOf)} for ${describe(plan.want, this.opts.nameOf)}`;
      const what = req.kind === 'seek' ? `${req.user.pseudo} is looking for ${req.character.name}` : `${req.user.pseudo} offers ${req.character.name}`;

      if (this.opts.mode === 'preview') {
        this.notifier.notify({ type: 'trade.preview', title: `Would offer ${req.user.pseudo}: ${summary}`, detail: `${what} (room ${req.room}). Preview mode: nothing was sent.`, data: { toUserId: req.user.id, characterId: req.character.id } });
        continue;
      }
      if (plan.give.chakra > 0 && committed + plan.give.chakra > limits.budget) continue;

      const message = this.opts.message.replaceAll('{pseudo}', req.user.pseudo).replaceAll('{name}', req.character.name).trim().slice(0, 200);
      try {
        const out = await this.trades.propose(
          { toUserId: req.user.id, give: plan.give, want: plan.want, ...(message ? { message } : {}) },
          { assumeYes: true, keep: rules.give.keep, summary: `Trade with ${req.user.pseudo}: ${summary}` },
        );
        if (out.status !== 'succeeded') continue;
        this.passWarned = false;
        this.p.sent.push({ tradeId: out.result.trade?.id ?? null, toUserId: req.user.id, pseudo: req.user.pseudo, at: new Date(now).toISOString(), give: plan.give, want: plan.want, summary, status: 'pending' });
        this.p.stats.sent++;
        pendingAll++;
        committed += plan.give.chakra;
        chakra -= plan.give.chakra;
        for (const c of plan.give.cards) spare.set(c.characterId, (spare.get(c.characterId) ?? 0) - c.qty); // the copy is locked now
        this.notifier.notify({ type: 'trade.sent', title: `Trade sent to ${req.user.pseudo}`, detail: `${summary} · ${what}`, data: { toUserId: req.user.id } });
      } catch (err) {
        if (err instanceof ActionRefusedError) {
          this.log.info(`Trade to ${req.user.pseudo} refused: ${err.message}`);
          continue;
        }
        if (err instanceof HumanVerificationError) {
          if (!this.passWarned) {
            this.passWarned = true;
            this.notifier.notify({ type: 'trade.needs-pass', title: 'Kyara wants its anti-bot pass to send trades', detail: 'Trades resume while kyara.games is open and visible (the pass is synced from there).' });
          }
          return;
        }
        if (err instanceof AmbiguousOutcomeError) {
          this.p.halted = true;
          this.notifier.notify({ type: 'trade.unknown', title: 'Trade outcome unknown; auto-trading stopped', detail: `${err.message} Check your trades on Kyara, then save the monitor again to resume.` });
          return;
        }
        if (err instanceof KyaraApiError && err.code === 'too_many_trades') return void this.log.info('Kyara says too many trades are pending.');
        if (err instanceof KyaraApiError && err.status < 500) {
          this.log.info(`Trade to ${req.user.pseudo} refused by Kyara: ${err.message}`);
          continue;
        }
        throw err;
      }
    }
  }
}

function sig(s: TradeCards): string {
  return `${s.cards.map((c) => `${c.characterId}x${c.qty}`).sort().join('+')}+${s.chakra || 0}`;
}

function describe(s: TradeCards, nameOf?: (id: number) => string | undefined): string {
  const parts = s.cards.map((c) => `${c.qty > 1 ? `${c.qty}× ` : ''}${nameOf?.(c.characterId) ?? `#${c.characterId}`}`);
  if (s.chakra) parts.push(`${s.chakra} chakra`);
  return parts.join(' + ') || 'nothing';
}
