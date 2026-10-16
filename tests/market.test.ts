import { describe, expect, it } from 'vitest';
import type { Listing } from '../src/api/schemas/market.js';
import { applyListingFilter, checkBiddable, checkBuyable } from '../src/modules/MarketModule.js';
import type { ActionRefusedError} from '../src/utils/errors.js';
import { AmbiguousOutcomeError, UsageError } from '../src/utils/errors.js';
import { ME, MockTransport, fixture, makeBot } from './helpers.js';

const page = fixture<{ items: Listing[]; total: number }>('listings.json');
const ID = '11111111-2222-4333-8444-555555555555';
const ACCESS_OK = { allowed: true, reasons: [], discord: true, accountAgeDays: 40, boostersOpened: 140, gating: true };
const future = new Date(Date.now() + 3600_000).toISOString();

function listing(o: Partial<Listing> = {}): Listing {
  return {
    ...page.items[0]!,
    id: ID,
    type: 'auction',
    status: 'active',
    price: 100,
    currentBid: 120,
    minNextBid: 130,
    buyoutPrice: 1000,
    bidCount: 2,
    endsAt: future,
    isMine: false,
    myMaxBid: null,
    leading: null,
    ...o,
  };
}

const reason = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    return (e as ActionRefusedError).reason;
  }
  return 'ok';
};

describe('checkBiddable', () => {
  it('accepts a valid bid', () => expect(reason(() => checkBiddable(listing(), 150, 500))).toBe('ok'));
  it('rejects too-low, buyout-reaching, own, ended, fixed, and unaffordable bids', () => {
    expect(reason(() => checkBiddable(listing(), 129, 500))).toBe('invalid_input');
    expect(reason(() => checkBiddable(listing(), 1000, 5000))).toBe('invalid_input');
    expect(reason(() => checkBiddable(listing({ isMine: true }), 150, 500))).toBe('prerequisite');
    expect(reason(() => checkBiddable(listing({ endsAt: new Date(Date.now() - 1000).toISOString() }), 150, 500))).toBe('prerequisite');
    expect(reason(() => checkBiddable(listing({ type: 'fixed' }), 150, 500))).toBe('prerequisite');
    expect(reason(() => checkBiddable(listing(), 150, 149))).toBe('insufficient_funds');
  });
  it('counts chakra already reserved by my previous maximum', () => {
    expect(reason(() => checkBiddable(listing({ myMaxBid: 140 }), 200, 60))).toBe('ok');
    expect(reason(() => checkBiddable(listing({ myMaxBid: 200 }), 150, 1000))).toBe('duplicate');
  });
});

describe('checkBuyable', () => {
  it('uses the sale price or the buyout price', () => {
    expect(checkBuyable(listing({ type: 'fixed', price: 300 }), 300)).toBe(300);
    expect(checkBuyable(listing({ buyoutPrice: 800 }), 900)).toBe(800);
  });
  it('rejects auctions without buyout, over-limit and unaffordable purchases', () => {
    expect(reason(() => checkBuyable(listing({ buyoutPrice: null }), 1e6))).toBe('prerequisite');
    expect(reason(() => checkBuyable(listing({ type: 'fixed', price: 300 }), 1e6, 200))).toBe('over_budget');
    expect(reason(() => checkBuyable(listing({ type: 'fixed', price: 300 }), 299))).toBe('insufficient_funds');
  });
});

describe('applyListingFilter', () => {
  it('filters by price, end time and ownership locally', () => {
    const items = [listing({ id: 'a', currentBid: 50 }), listing({ id: 'b', currentBid: 500 }), listing({ id: 'c', isMine: true, currentBid: 10 })];
    expect(applyListingFilter(items, { maxPrice: 100, excludeMine: true }).map((l) => l.id)).toEqual(['a']);
    expect(applyListingFilter(items, { endingWithinMs: 60_000 })).toHaveLength(0);
  });
});

describe('MarketModule', () => {
  it('validates listing queries before sending', async () => {
    const t = new MockTransport();
    const { bot } = makeBot(t);
    expect(() => bot.market.search({ pageSize: 51 })).toThrow(UsageError);
    expect(() => bot.market.search({ sort: 'bogus' as never })).toThrow(UsageError);
    expect(t.requests).toHaveLength(0);
  });

  it('paginates boundedly', async () => {
    const mk = (n: number) => Array.from({ length: n }, (_, i) => listing({ id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}` }));
    const t = new MockTransport().on('GET /market/listings', { body: { items: mk(50), total: 120 } }, { body: { items: mk(50), total: 120 } }, { body: { items: mk(20), total: 120 } });
    const { bot } = makeBot(t);
    const r = await bot.market.searchPages({ sort: 'ending' }, 10);
    expect(r.items).toHaveLength(120);
    expect(t.calls('GET /market/listings')).toHaveLength(3);
    expect(new URL(t.requests[1]!.url).searchParams.get('page')).toBe('2');
    const t2 = new MockTransport().on('GET /market/listings', { body: { items: mk(50), total: 9999 } });
    const { bot: b2 } = makeBot(t2);
    await b2.market.searchPages({}, 2);
    expect(t2.requests).toHaveLength(2);
  });

  it('places a confirmed bid after preflight and records it', async () => {
    const t = new MockTransport()
      .on('GET /market/listings/' + ID, { body: listing() })
      .on('GET /me', { body: ME })
      .on('GET /me/market/access', { body: ACCESS_OK })
      .on('POST /market/listings/' + ID + '/bid', { body: { user: { ...ME, chakra: 850 }, listing: { currentBid: 130 }, leading: true } });
    const { bot } = makeBot(t);
    const prompts: string[] = [];
    const out = await bot.market.bid(ID, 150, { confirm: async (s) => (prompts.push(s), true) });
    expect(out.status).toBe('succeeded');
    expect(prompts[0]).toContain('Bid up to 150');
    expect(JSON.parse(t.calls('POST /market/listings/' + ID + '/bid')[0]!.body!)).toEqual({ maxAmount: 150 });
    expect(bot.journal.list()[0]).toMatchObject({ status: 'succeeded', kind: 'market.bid', cost: 150 });
  });

  it('refuses a bid with insufficient funds without sending it', async () => {
    const t = new MockTransport().on('GET /market/listings/' + ID, { body: listing() })
      .on('GET /me', { body: { ...ME, chakra: 10 } })
      .on('GET /me/market/access', { body: ACCESS_OK });
    const { bot } = makeBot(t);
    const err = (await bot.market.bid(ID, 150, { assumeYes: true }).catch((e: unknown) => e)) as ActionRefusedError;
    expect(err.reason).toBe('insufficient_funds');
    expect(t.calls('POST /market/listings/' + ID + '/bid')).toHaveLength(0);
  });

  it('flags an ambiguous purchase and blocks a second attempt', async () => {
    const t = new MockTransport()
      .on('GET /market/listings/' + ID, { body: listing({ type: 'fixed', price: 300 }) })
      .on('GET /me', { body: ME })
      .on('GET /me/market/access', { body: ACCESS_OK })
      .on('POST /market/listings/' + ID + '/buy', { status: 502, body: { error: 'http_502' } });
    const { bot } = makeBot(t);
    expect(await bot.market.buy(ID, { assumeYes: true }).catch((e: unknown) => e)).toBeInstanceOf(AmbiguousOutcomeError);
    const again = (await bot.market.buy(ID, { assumeYes: true }).catch((e: unknown) => e)) as ActionRefusedError;
    expect(again.reason).toBe('pending_unknown');
    expect(t.calls('POST /market/listings/' + ID + '/buy')).toHaveLength(1);
  });

  it('refuses bids and purchases while the market is locked, with the server reasons', async () => {
    const t = new MockTransport()
      .on('GET /market/listings/' + ID, { body: listing() })
      .on('GET /me', { body: ME })
      .on('GET /me/market/access', { body: { allowed: false, reasons: ['Compte trop récent.'], gating: true } });
    const { bot } = makeBot(t);
    const err = (await bot.market.bid(ID, 150, { assumeYes: true }).catch((e: unknown) => e)) as ActionRefusedError;
    expect(err.reason).toBe('prerequisite');
    expect(err.message).toContain('Compte trop récent.');
    expect(t.requests.some((r) => r.method === 'POST')).toBe(false);
  });

  it('rejects malformed listing ids before any request', async () => {
    const t = new MockTransport();
    const { bot } = makeBot(t);
    await expect(bot.market.bid('not-a-uuid', 10, { assumeYes: true })).rejects.toBeInstanceOf(UsageError);
    expect(t.requests).toHaveLength(0);
  });
});
