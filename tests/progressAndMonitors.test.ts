import { describe, expect, it } from 'vitest';
import type { Listing } from '../src/api/schemas/market.js';
import { listClaimables } from '../src/modules/ProgressModule.js';
import { AccountWatcher } from '../src/services/AccountWatcher.js';
import type { AuctionProgress, AutoBidPolicy } from '../src/services/AuctionMonitor.js';
import { AuctionMonitor } from '../src/services/AuctionMonitor.js';
import { MemoryNotifier } from '../src/services/Notifier.js';
import { poll } from '../src/services/Poller.js';
import type { ActionRefusedError} from '../src/utils/errors.js';
import { AuthRequiredError } from '../src/utils/errors.js';
import { silentLogger } from '../src/utils/logger.js';
import { ME, MockTransport, fixture, makeBot, openResult } from './helpers.js';

const PROGRESS = {
  claimable: 2,
  resets: { nextDaily: new Date(Date.now() + 3600_000).toISOString(), nextWeekly: null },
  streak: { day: 3, claimedToday: false },
  achievements: [
    { id: 'a1', label: 'First pack', done: true, claimed: false },
    { id: 'a2', label: 'Other', done: false, claimed: false },
  ],
  series: [{ series: 'ONE PIECE', size: 70, total: 70, claimed: false }],
};

describe('ProgressModule', () => {
  it('lists claimables', () => {
    const items = listClaimables({ ...PROGRESS, daily: null, weekly: null, welcome: null } as never);
    expect(items.map((i) => i.kind)).toEqual(['streak', 'achievement', 'series']);
  });

  it('claims all without a prompt and records the gain', async () => {
    const t = new MockTransport()
      .on('GET /me/progress', { body: PROGRESS })
      .on('POST /me/progress/claim', { body: { progress: { ...PROGRESS, claimable: 0 }, user: { ...ME, chakra: 1100 }, gained: { chakra: 100, grants: {} } } });
    const { bot } = makeBot(t);
    const out = await bot.progress.claim('all');
    expect(out.status).toBe('succeeded');
    expect(JSON.parse(t.calls('POST /me/progress/claim')[0]!.body!)).toEqual({ kind: 'all' });
  });

  it('refuses when nothing is claimable, and validates kinds needing an id', async () => {
    const t = new MockTransport().on('GET /me/progress', { body: { ...PROGRESS, claimable: 0 } });
    const { bot } = makeBot(t);
    expect(((await bot.progress.claim('all').catch((e: unknown) => e)) as ActionRefusedError).reason).toBe('prerequisite');
    expect(((await bot.progress.claim('series').catch((e: unknown) => e)) as ActionRefusedError).reason).toBe('invalid_input');
    expect(t.calls('POST /me/progress/claim')).toHaveLength(0);
  });
});

describe('poll', () => {
  const sleeps: number[] = [];
  const base = { minIntervalMs: 1000, maxDurationMs: 1e9, log: silentLogger, sleepFn: async (ms: number) => void sleeps.push(ms), random: () => 0.5 };

  it('enforces the interval floor and stops after maxTicks', async () => {
    sleeps.length = 0;
    let n = 0;
    const r = await poll(async () => void n++, { ...base, intervalMs: 10, maxTicks: 3 });
    expect(r).toEqual({ ticks: 3, reason: 'max ticks reached' });
    expect(sleeps.every((s) => s >= 1000)).toBe(true);
  });

  it('backs off exponentially on errors', async () => {
    sleeps.length = 0;
    await poll(async () => Promise.reject(new Error('x')), { ...base, intervalMs: 1000, maxTicks: 3 });
    expect(sleeps).toEqual([2000, 4000]);
  });

  it('wakes early on a hint, clamped to the floor and the interval', async () => {
    sleeps.length = 0;
    const hints = [5_000, 10, 1e9, undefined];
    await poll(async (i) => hints[i], { ...base, intervalMs: 60_000, maxTicks: 4 });
    expect(sleeps).toEqual([5_000, 1_000, 60_000]);
  });

  it('stops immediately on auth errors and on abort', async () => {
    await expect(poll(async () => Promise.reject(new AuthRequiredError()), { ...base, intervalMs: 1000 })).rejects.toBeInstanceOf(AuthRequiredError);
    const ac = new AbortController();
    const r = await poll(async () => ac.abort(), { ...base, intervalMs: 1000, signal: ac.signal, sleepFn: (_ms, s) => (s?.aborted ? Promise.reject(new Error('aborted')) : Promise.resolve()) });
    expect(r.reason).toBe('stopped');
  });
});

describe('AuctionMonitor', () => {
  const page = fixture<{ items: Listing[]; total: number }>('listings.json');
  const ID = '11111111-2222-4333-8444-555555555555';
  const soon = (ms: number) => new Date(Date.now() + ms).toISOString();
  const auction = (o: Partial<Listing>): Listing => ({ ...page.items[0]!, id: ID, type: 'auction', status: 'active', currentBid: 100, minNextBid: 110, buyoutPrice: null, isMine: false, myMaxBid: null, leading: null, endsAt: soon(60_000), ...o });

  it('notifies matches and ending-soon once each (no auto-bid by default)', async () => {
    const t = new MockTransport().on('GET /market/listings', { body: { items: [auction({})], total: 1 } });
    const { bot } = makeBot(t);
    const n = new MemoryNotifier();
    const mon = new AuctionMonitor(bot.market, n, silentLogger, { query: {}, filter: { maxPrice: 500 }, endingSoonMs: 120_000, maxPages: 1 });
    await mon.tick();
    await mon.tick();
    expect(n.events.map((e) => e.type)).toEqual(['listing.match', 'auction.ending']);
    expect(t.requests.some((r) => r.method === 'POST')).toBe(false);
  });

  it('notifies when outbid', async () => {
    const t = new MockTransport().on('GET /market/listings', { body: { items: [auction({ leading: true })], total: 1 } }, { body: { items: [auction({ leading: false })], total: 1 } });
    const { bot } = makeBot(t);
    const n = new MemoryNotifier();
    const mon = new AuctionMonitor(bot.market, n, silentLogger, { query: {}, filter: {}, endingSoonMs: 0, maxPages: 1 });
    await mon.tick();
    await mon.tick();
    expect(n.events.map((e) => e.type)).toContain('auction.outbid');
  });

  const OTHER = '22222222-2222-4333-8444-555555555555';
  const policy = (o: Partial<AutoBidPolicy> = {}): AutoBidPolicy => ({ enabled: true, budget: 10_000, maxBid: 500, onlyWithinMs: 120_000, copies: 1, ...o });
  const bidding = (items: Listing[]) => {
    const t = new MockTransport()
      .on('GET /market/listings', { body: { items, total: items.length } })
      .on('GET /me', { body: ME })
      .on('GET /me/market/access', { body: { allowed: true, reasons: [] } });
    for (const l of items) t.on('GET /market/listings/' + l.id, { body: l }).on('POST /market/listings/' + l.id + '/bid', { body: { user: ME, listing: { currentBid: l.minNextBid }, leading: true } });
    return t;
  };

  it('sends your maximum once as a proxy bid, capped by the max price, and stops at the copies target', async () => {
    const t = bidding([auction({}), auction({ id: OTHER })]);
    const { bot } = makeBot(t);
    const n = new MemoryNotifier();
    const mon = new AuctionMonitor(bot.market, n, silentLogger, { query: {}, filter: { maxPrice: 200 }, endingSoonMs: 0, maxPages: 1, autoBid: policy({ copies: 1 }) });
    await mon.tick();
    const bids = t.requests.filter((r) => r.method === 'POST');
    expect(bids).toHaveLength(1);
    expect(JSON.parse(bids[0]!.body!)).toEqual({ maxAmount: 200 });
    expect(mon.copies).toEqual({ won: 0, leading: 1, target: 1 });
    expect(mon.reservedChakra).toBe(200);
  });

  it('bids on as many auctions as copies wanted, within the budget', async () => {
    const third = '33333333-2222-4333-8444-555555555555';
    const t = bidding([auction({}), auction({ id: OTHER }), auction({ id: third })]);
    const { bot } = makeBot(t);
    const mon = new AuctionMonitor(bot.market, new MemoryNotifier(), silentLogger, { query: {}, filter: { maxPrice: 200 }, endingSoonMs: 0, maxPages: 1, autoBid: policy({ copies: 3, budget: 400 }) });
    await mon.tick();
    expect(t.requests.filter((r) => r.method === 'POST')).toHaveLength(2); // the third would exceed 400
  });

  it('keeps the bid under the buyout and skips auctions already above your maximum', async () => {
    const t = bidding([auction({ buyoutPrice: 150 }), auction({ id: OTHER, minNextBid: 300 })]);
    const { bot } = makeBot(t);
    const mon = new AuctionMonitor(bot.market, new MemoryNotifier(), silentLogger, { query: {}, filter: { maxPrice: 1000 }, endingSoonMs: 0, maxPages: 1, autoBid: policy({ maxBid: 200, copies: 2 }) });
    await mon.tick();
    const bids = t.requests.filter((r) => r.method === 'POST');
    expect(bids.map((b) => b.url)).toEqual([expect.stringContaining(ID)]);
    expect(JSON.parse(bids[0]!.body!)).toEqual({ maxAmount: 149 });
  });

  it('counts a won auction toward the copies, persists it, and bids on the next one after a loss', async () => {
    const ended = auction({ endsAt: soon(-60_000), status: 'ended', leading: true, myMaxBid: 200, finalPrice: 130 });
    const t = new MockTransport()
      .on('GET /market/listings', { body: { items: [], total: 0 } })
      .on('GET /market/listings/' + ID, { body: ended });
    const { bot } = makeBot(t);
    const n = new MemoryNotifier();
    const saved: AuctionProgress[] = [];
    const mon = new AuctionMonitor(bot.market, n, silentLogger, {
      query: {},
      filter: { maxPrice: 200 },
      endingSoonMs: 0,
      maxPages: 1,
      autoBid: policy({ copies: 1 }),
      progress: { won: [], tracked: [{ id: ID, name: 'X', amount: 200, endsAt: ended.endsAt, leading: true }], halted: false },
      onProgress: (p) => saved.push(p),
    });
    await mon.tick();
    expect(n.events.map((e) => e.type)).toContain('auction.won');
    expect(mon.copies).toEqual({ won: 1, leading: 0, target: 1 });
    expect(mon.reservedChakra).toBe(130);
    expect(saved.at(-1)?.won).toHaveLength(1);
  });

  it('wakes up when the next auction enters the bidding window', async () => {
    const now = Date.now();
    const t = new MockTransport().on('GET /market/listings', { body: { items: [auction({ endsAt: new Date(now + 600_000).toISOString() })], total: 1 } });
    const { bot } = makeBot(t);
    const mon = new AuctionMonitor(bot.market, new MemoryNotifier(), silentLogger, { query: {}, filter: { maxPrice: 200 }, endingSoonMs: 0, maxPages: 1, autoBid: policy() });
    expect(await mon.tick(now)).toBe(600_000 - 120_000 + 2_000);
  });

  it('never auto-bids when the next bid is above the price ceiling', async () => {
    const t = new MockTransport().on('GET /market/listings', { body: { items: [auction({ minNextBid: 300 })], total: 1 } });
    const { bot } = makeBot(t);
    const mon = new AuctionMonitor(bot.market, new MemoryNotifier(), silentLogger, {
      query: {},
      filter: { maxPrice: 1000 },
      endingSoonMs: 0,
      maxPages: 1,
      autoBid: policy({ maxBid: 200 }),
    });
    await mon.tick();
    expect(t.requests.some((r) => r.method === 'POST')).toBe(false);
  });
});

describe('AccountWatcher', () => {
  it('notifies free packs full, claimable rewards and free packs available, without acting', async () => {
    const t = new MockTransport()
      .on('GET /me', { body: { ...ME, freePacks: 10 } })
      .on('GET /me/packs', { body: { limits: {} } })
      .on('GET /me/progress', { body: PROGRESS })
      .on('GET /packs', { body: fixture('packs.json') })
      .on('GET /config', { body: fixture('config.json') });
    const { bot } = makeBot(t);
    const n = new MemoryNotifier();
    const w = new AccountWatcher(bot.account, bot.progress, bot.packs, n, silentLogger, { autoClaim: false, autoOpenFreePack: null });
    await w.tick();
    const types = n.events.map((e) => e.type);
    expect(types).toContain('packs.free.full');
    expect(types).toContain('rewards.claimable');
    expect(types).toContain('packs.available'); // daily pack, free once per day
    expect(t.requests.some((r) => r.method === 'POST')).toBe(false);
  });

  const watching = (me: Record<string, unknown>, turnstile: string | null = '0xSITEKEY') =>
    new MockTransport()
      .on('GET /me', { body: me })
      .on('GET /me/packs', { body: { limits: {} } })
      .on('GET /me/progress', { body: { ...PROGRESS, claimable: 0 } })
      .on('GET /packs', { body: fixture('packs.json') })
      .on('GET /config', { body: fixture('config.json') })
      .on('GET /auth/providers', { body: { discord: true, turnstile } });

  it('opens free packs without any pass while Kyara has its Turnstile check off, like the site', async () => {
    const t = watching({ ...ME, freePacks: 2 }, null).on('POST /packs/all/open-many', { body: { results: [openResult(1000), openResult(1000)] } });
    const { bot } = makeBot(t);
    const n = new MemoryNotifier();
    const w = new AccountWatcher(bot.account, bot.progress, bot.packs, n, silentLogger, { autoClaim: false, autoOpenFreePack: 'all' });
    await w.tick();
    const req = t.calls('POST /packs/all/open-many')[0]!;
    expect(req.headers['x-pass']).toBeUndefined();
    expect(JSON.parse(req.body!)).toEqual({ count: 2, maxChakra: 0 });
    expect(n.events.some((e) => e.type === 'packs.autoopen.blocked')).toBe(false);
  });

  it('opens every free pack in one request and wakes when the next one regenerates', async () => {
    const now = Date.now();
    const me = { ...ME, freePacks: 3, nextFreeAt: new Date(now + 600_000).toISOString() };
    const t = watching(me).on('POST /packs/all/open-many', { body: { results: [openResult(1000), openResult(1000), openResult(1000)] } });
    const { bot } = makeBot(t);
    bot.passes.importPass(JSON.stringify({ pass: 'imported-pass-123456', expiresAt: now + 20 * 60_000 }), 'device-1');
    const n = new MemoryNotifier();
    const w = new AccountWatcher(bot.account, bot.progress, bot.packs, n, silentLogger, { autoClaim: false, autoOpenFreePack: 'all' });
    expect(await w.tick(now)).toBe(605_000);
    expect(JSON.parse(t.calls('POST /packs/all/open-many')[0]!.body!)).toEqual({ count: 3, maxChakra: 0 });
    expect(n.events.find((e) => e.type === 'packs.opened')?.title).toBe('Opened 3× Shōnen Mix (free)');
  });

  it('says once why free packs were not opened when there is no pack pass', async () => {
    const t = watching({ ...ME, freePacks: 2 });
    const { bot } = makeBot(t);
    const n = new MemoryNotifier();
    const w = new AccountWatcher(bot.account, bot.progress, bot.packs, n, silentLogger, { autoClaim: false, autoOpenFreePack: 'all' });
    await w.tick();
    await w.tick();
    const blocked = n.events.filter((e) => e.type === 'packs.autoopen.blocked');
    expect(blocked).toHaveLength(1);
    expect(blocked[0]!.detail).toMatch(/pack pass/);
    expect(t.requests.some((r) => r.method === 'POST')).toBe(false);
  });
});

describe('stopped monitors never spend', () => {
  it('an auction monitor that is no longer active places no bid', async () => {
    const page = fixture<{ items: Listing[]; total: number }>('listings.json');
    const l = { ...page.items[0]!, id: '11111111-2222-4333-8444-555555555555', type: 'auction' as const, status: 'active', currentBid: 100, minNextBid: 110, buyoutPrice: null, isMine: false, myMaxBid: null, leading: null, endsAt: new Date(Date.now() + 60_000).toISOString() };
    const t = new MockTransport().on('GET /market/listings', { body: { items: [l], total: 1 } });
    const { bot } = makeBot(t);
    let active = true;
    const mon = new AuctionMonitor(bot.market, new MemoryNotifier(), silentLogger, {
      query: {},
      filter: { maxPrice: 500 },
      endingSoonMs: 0,
      maxPages: 1,
      autoBid: { enabled: true, budget: 1000, maxBid: 500, onlyWithinMs: 120_000, copies: 1 },
      isActive: () => active,
    });
    active = false;
    await mon.tick();
    expect(t.requests.some((r) => r.method === 'POST')).toBe(false);
  });
});
