import { describe, expect, it } from 'vitest';
import type { FairPlay } from '../src/api/schemas/trades.js';
import { fairVerdict } from '../src/modules/tradeFairness.js';
import type { PlanContext, TradeRequest, TradeRules } from '../src/modules/tradePlanner.js';
import { planTrade, spareCopies } from '../src/modules/tradePlanner.js';
import { MemoryNotifier } from '../src/services/Notifier.js';
import type { TradeMonitorOptions } from '../src/services/TradeMonitor.js';
import { TradeMonitor } from '../src/services/TradeMonitor.js';
import { silentLogger } from '../src/utils/logger.js';
import { ME, MockTransport, makeBot } from './helpers.js';

const FP: FairPlay = { enabled: true, freeRatio: 2, ignoreBelow: 100, receivedDays: 2, pairDays: 2, giveLeft: 3000, getLeft: 3000, giveBalanceLeft: 5000, getBalanceLeft: 5000, myReceivedLeft: 10000, theirReceivedLeft: 10000 };
const side = (cards: Array<[number, number]>, chakra = 0) => ({ cards: cards.map(([characterId, qty]) => ({ characterId, qty })), chakra });

describe('fairVerdict (port of the site check)', () => {
  const prices = new Map([
    [1, 100],
    [2, 120],
    [3, 1000],
  ]);
  it('is fair inside the free ratio or under ignoreBelow, a gift beyond, over past the limits', () => {
    expect(fairVerdict(side([[1, 1]]), side([[2, 1]]), prices, FP)).toEqual({ kind: 'fair' });
    expect(fairVerdict(side([[1, 1]]), side([], 190), prices, FP)).toEqual({ kind: 'fair' }); // difference under ignoreBelow
    expect(fairVerdict(side([[1, 1]]), side([], 250), prices, FP)).toEqual({ kind: 'gift', out: false, amount: 50 }); // 250 − 2×100
    expect(fairVerdict(side([[3, 1]]), side([[1, 1]]), prices, FP)).toEqual({ kind: 'gift', out: true, amount: 800 });
    expect(fairVerdict(side([[3, 1]]), side([[1, 1]]), prices, { ...FP, giveLeft: 500 }).kind).toBe('over');
    expect(fairVerdict(side([[9, 1]]), side([[1, 1]]), prices, FP)).toEqual({ kind: 'unpriced', missing: [9] });
    expect(fairVerdict(side([[3, 1]]), side([[1, 1]]), prices, { ...FP, enabled: false })).toEqual({ kind: 'fair' });
  });
});

describe('spareCopies', () => {
  it('keeps one copy (site rule), locked and recently traded copies, plus the extra kept', () => {
    expect(spareCopies({ qty: 1 }, 0)).toBe(0);
    expect(spareCopies({ qty: 4, locked: 1, resaleLocked: 1 }, 0)).toBe(1);
    expect(spareCopies({ qty: 4 }, 2)).toBe(1);
  });
});

const RULES: TradeRules = {
  give: { keep: 0, rarities: [], exclude: [] },
  seek: { enabled: true, wishMinPct: 80, wishMaxPct: 130, allowChakra: true, markupPct: 110 },
  offer: { enabled: true, payWithCards: true, payWithChakra: true, minPayPct: 80, maxPayPct: 110, maxChakra: 200, maxCards: 3, onlyMissing: true },
};
const THEM = { id: '11111111-1111-4111-8111-111111111111', pseudo: 'them' };
const req = (kind: 'seek' | 'offer', id: number): TradeRequest => ({ kind, messageId: 'm1', room: 1, at: new Date().toISOString(), user: THEM, character: { id, name: `Char ${id}`, rarity: 'R' } });
const ctx = (o: Partial<PlanContext> = {}): PlanContext => ({
  spare: new Map([[10, 2]]),
  rarityOf: () => 'R',
  owned: new Set([10]),
  wishlist: new Set([20, 21]),
  theirAvailable: new Map([
    [20, 1],
    [21, 1],
  ]),
  theirOwned: null,
  prices: new Map([
    [10, 100],
    [20, 90],
    [21, 125],
    [30, 100],
  ]),
  fairPlay: FP,
  chakraAvailable: 1000,
  ...o,
});

describe('planTrade', () => {
  it('seek: asks for the most valuable wishlist card in range', () => {
    const p = planTrade(req('seek', 10), ctx(), RULES);
    expect(p).toMatchObject({ ok: true, give: side([[10, 1]]), want: side([[21, 1]]) });
  });

  it('seek: falls back to chakra at the markup, and skips without a spare copy or when the rarity is not allowed', () => {
    expect(planTrade(req('seek', 10), ctx({ theirAvailable: new Map() }), RULES)).toMatchObject({ ok: true, want: side([], 110) });
    expect(planTrade(req('seek', 10), ctx({ spare: new Map() }), RULES)).toEqual({ ok: false, reason: 'no spare copy' });
    expect(planTrade(req('seek', 10), ctx(), { ...RULES, give: { ...RULES.give, rarities: ['L'] } }).ok).toBe(false);
    expect(planTrade(req('seek', 10), ctx({ theirAvailable: new Map() }), { ...RULES, seek: { ...RULES.seek, allowChakra: false } }).ok).toBe(false);
  });

  it('offer: pays with one spare card they lack, else with chakra within the cap', () => {
    const c = ctx({ spare: new Map([[10, 1], [30, 1]]), theirOwned: new Set([10]), prices: new Map([[10, 95], [20, 90], [30, 95]]) });
    expect(planTrade(req('offer', 20), c, RULES)).toMatchObject({ ok: true, give: side([[30, 1]]), want: side([[20, 1]]) });
    expect(planTrade(req('offer', 20), ctx({ spare: new Map() }), RULES)).toMatchObject({ ok: true, give: side([], 90) });
    expect(planTrade(req('offer', 21), ctx({ spare: new Map() }), { ...RULES, offer: { ...RULES.offer, maxChakra: 50 } })).toMatchObject({ ok: false });
  });

  it('offer: skips characters not on the wishlist, already owned, or not tradeable by them', () => {
    expect(planTrade(req('offer', 30), ctx(), RULES)).toEqual({ ok: false, reason: 'not on my wishlist' });
    expect(planTrade(req('offer', 20), ctx({ owned: new Set([20]) }), RULES)).toEqual({ ok: false, reason: 'already owned' });
    expect(planTrade(req('offer', 20), ctx({ theirAvailable: new Map() }), RULES)).toEqual({ ok: false, reason: 'they have no tradeable copy' });
  });

  it('offer: combines several spare cards when no single one fits', () => {
    const c = ctx({ spare: new Map([[40, 1], [41, 1], [42, 1]]), prices: new Map([[20, 90], [40, 40], [41, 35], [42, 30]]) });
    const p = planTrade(req('offer', 20), c, RULES);
    expect(p).toMatchObject({ ok: true, give: side([[40, 1], [41, 1]]) });
  });
});

describe('TradeMonitor', () => {
  const T_ID = '22222222-2222-4222-8222-222222222222';
  const msg = (tag: string, id: number, at = new Date().toISOString()) => ({
    id: `msg-${tag}-${id}-${at}`,
    text: 'Anyone have it?',
    room: 1,
    createdAt: at,
    author: THEM,
    attachment: { kind: 'card', tag, character: { id, name: `Char ${id}`, rarity: 'R' } },
  });
  const PRICES: Record<number, number> = { 10: 100, 20: 90, 21: 125 };
  const pending = (o: Record<string, unknown> = {}) => ({
    id: T_ID,
    from: { id: ME.id, pseudo: 'tester' },
    to: THEM,
    give: side([[10, 1]]),
    want: side([[21, 1]]),
    status: 'pending',
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 48 * 3600_000).toISOString(),
    ...o,
  });
  const ME_ID = { ...ME, id: '00000000-0000-4000-8000-00000000aaaa' };

  function setup(items: unknown[], outgoing: unknown[] | (() => unknown[]) = []) {
    const t = new MockTransport()
      .on('GET /me', { body: ME_ID })
      .on('GET /me/trades', () => ({ body: { incoming: [], outgoing: typeof outgoing === 'function' ? outgoing() : outgoing } }))
      .on('GET /market/chat/rooms', { body: { rooms: [{ room: 1, count: 3 }] } })
      .on('GET /market/chat', { body: { items, hasMore: false } })
      .on('GET /me/collection', { body: [{ characterId: 10, qty: 3, locked: 0, resaleLocked: 0 }] })
      .on('GET /me/wishlist', { body: [20, 21] })
      .on('GET /trades/available/' + THEM.id, { body: [{ characterId: 21, n: 1 }] })
      .on('GET /trades/owned/' + THEM.id, { body: [21] })
      .on('GET /fair-play/with/' + THEM.id, { body: FP })
      .on('GET /fair-play/prices', (r) => {
        const ids = (new URL(r.url).searchParams.get('ids') ?? '').split(',').map(Number);
        return { body: Object.fromEntries(ids.filter((i) => PRICES[i] !== undefined).map((i) => [i, PRICES[i]])) };
      })
      .on('POST /trades', { body: { user: ME_ID, trade: pending() } })
      .on('POST /trades/' + T_ID + '/cancel', { body: { user: ME_ID } });
    const { bot } = makeBot(t);
    return { t, bot };
  }
  const opts = (o: Partial<TradeMonitorOptions> = {}): TradeMonitorOptions => ({
    rules: RULES,
    limits: { maxPending: 3, maxPerHour: 5, perUserMs: 24 * 3600_000, expireMs: 30 * 60_000, budget: 0 },
    mode: 'auto',
    rooms: null,
    maxAgeMs: 10 * 60_000,
    message: 'Hi {pseudo}! Saw your {name}.',
    ...o,
  });

  it('preview mode says what it would send and sends nothing', async () => {
    const { t, bot } = setup([msg('seek', 10)]);
    const n = new MemoryNotifier();
    const m = new TradeMonitor(bot.api, bot.account, bot.trades, n, silentLogger, opts({ mode: 'preview' }));
    await m.tick();
    expect(n.events.map((e) => e.type)).toEqual(['trade.preview']);
    expect(t.requests.some((r) => r.method === 'POST')).toBe(false);
  });

  it('answers a seeker with a fair trade, with the message and the stored pass, once per player', async () => {
    const { t, bot } = setup([msg('seek', 10)]);
    bot.passes.importPass(JSON.stringify({ pass: 'imported-pass-123456', expiresAt: Date.now() + 20 * 60_000 }));
    const n = new MemoryNotifier();
    const m = new TradeMonitor(bot.api, bot.account, bot.trades, n, silentLogger, opts());
    await m.tick();
    const post = t.calls('POST /trades');
    expect(post).toHaveLength(1);
    expect(JSON.parse(post[0]!.body!)).toEqual({ toUserId: THEM.id, give: side([[10, 1]]), want: side([[21, 1]]), message: 'Hi them! Saw your Char 10.' });
    expect(post[0]!.headers['x-pass']).toBe('imported-pass-123456');
    expect(n.events.map((e) => e.type)).toContain('trade.sent');
    expect(m.pending).toBe(1);
    await m.tick(); // same message again: already handled; same player: cooldown
    expect(t.calls('POST /trades')).toHaveLength(1);
  });

  it('ignores old messages, its own messages and non-card messages', async () => {
    const old = new Date(Date.now() - 30 * 60_000).toISOString();
    const { t, bot } = setup([msg('seek', 10, old), { ...msg('seek', 10), author: { id: ME_ID.id, pseudo: 'me' } }, { ...msg('seek', 10), attachment: null }]);
    const m = new TradeMonitor(bot.api, bot.account, bot.trades, new MemoryNotifier(), silentLogger, opts());
    await m.tick();
    expect(t.calls('POST /trades')).toHaveLength(0);
  });

  it('stops at the pending limit', async () => {
    const { t, bot } = setup([msg('seek', 10)], [pending({ id: '33333333-3333-4333-8333-333333333333' })]);
    const m = new TradeMonitor(bot.api, bot.account, bot.trades, new MemoryNotifier(), silentLogger, opts({ limits: { ...opts().limits, maxPending: 1 } }));
    await m.tick();
    expect(t.calls('POST /trades')).toHaveLength(0);
  });

  it('reports an accepted trade and cancels unanswered ones after the delay', async () => {
    let status = 'accepted';
    const sentAt = new Date(Date.now() - 60 * 60_000).toISOString();
    const { t, bot } = setup([], () => [pending({ status, createdAt: sentAt })]);
    const base = { give: side([[10, 1]]), want: side([[21, 1]]), summary: 'x', toUserId: THEM.id, pseudo: 'them', at: sentAt, tradeId: T_ID };
    const n = new MemoryNotifier();
    const m = new TradeMonitor(bot.api, bot.account, bot.trades, n, silentLogger, opts({ progress: { lastSeen: {}, sent: [{ ...base, status: 'pending' }], stats: { sent: 1, accepted: 0, declined: 0, expired: 0, cancelled: 0 }, halted: false } }));
    await m.tick();
    expect(m.progress.stats.accepted).toBe(1);
    expect(n.events.map((e) => e.type)).toContain('trade.accepted');

    status = 'pending';
    const m2 = new TradeMonitor(bot.api, bot.account, bot.trades, n, silentLogger, opts({ progress: { lastSeen: {}, sent: [{ ...base, status: 'pending' }], stats: { sent: 1, accepted: 0, declined: 0, expired: 0, cancelled: 0 }, halted: false } }));
    await m2.tick();
    expect(t.calls('POST /trades/' + T_ID + '/cancel')).toHaveLength(1);
    expect(m2.progress.stats.expired).toBe(1);
  });

  it('reports a pass refusal once, and stops on an unclear outcome', async () => {
    const { t, bot } = setup([msg('seek', 10)]);
    t.on('POST /trades', { status: 403, body: { error: 'pass_required', message: 'pass' } });
    const n = new MemoryNotifier();
    const m = new TradeMonitor(bot.api, bot.account, bot.trades, n, silentLogger, opts());
    await m.tick();
    expect(n.events.map((e) => e.type)).toEqual(['trade.needs-pass']);

    const s2 = setup([msg('seek', 10)]);
    s2.t.on('POST /trades', { status: 200, body: { unexpected: true } });
    const n2 = new MemoryNotifier();
    const m2 = new TradeMonitor(s2.bot.api, s2.bot.account, s2.bot.trades, n2, silentLogger, opts());
    await m2.tick();
    expect(n2.events.map((e) => e.type)).toEqual(['trade.unknown']);
    expect(m2.progress.halted).toBe(true);
  });

  it('a stopped monitor never sends', async () => {
    const { t, bot } = setup([msg('seek', 10)]);
    const m = new TradeMonitor(bot.api, bot.account, bot.trades, new MemoryNotifier(), silentLogger, opts({ isActive: () => false }));
    await m.tick();
    expect(t.calls('POST /trades')).toHaveLength(0);
  });
});
