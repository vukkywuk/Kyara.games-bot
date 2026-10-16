import { describe, expect, it } from 'vitest';
import {
  CatalogNewsSchema,
  CharacterDetailSchema,
  CharacterListSchema,
  ConfigSchema,
  FeedSchema,
  LadderSchema,
  LeaderboardSchema,
  PackCharacterIdsSchema,
  PackListSchema,
  ProvidersSchema,
  RatesSchema,
  ReviewsSchema,
  HealthSchema,
} from '../src/api/schemas/public.js';
import { ListingPageSchema, OrderBookSchema, PriceHistorySchema, TradeOfferListSchema } from '../src/api/schemas/market.js';
import { ErrorBodySchema } from '../src/api/schemas/common.js';
import { ClaimResultSchema, MeSchema, OpenManyResultSchema, OpenResultSchema } from '../src/api/schemas/account.js';
import { CollectionEntrySchema, PackStateSchema } from '../src/api/schemas/account.js';
import { MarketAccessSchema, MyMarketSchema } from '../src/api/schemas/market.js';
import { summariseWallet } from '../src/modules/AccountModule.js';
import { ME, card, fixture, openResult } from './helpers.js';

describe('schemas accept sanitized live responses', () => {
  const cases: Array<[string, { safeParse(v: unknown): { success: boolean; error?: unknown } }]> = [
    ['characters.json', CharacterListSchema],
    ['character-detail.json', CharacterDetailSchema],
    ['config.json', ConfigSchema],
    ['health.json', HealthSchema],
    ['packs.json', PackListSchema],
    ['rates.json', RatesSchema],
    ['pack-characters.json', PackCharacterIdsSchema],
    ['listings.json', ListingPageSchema],
    ['prices.json', PriceHistorySchema],
    ['buy-orders.json', OrderBookSchema],
    ['leaderboard.json', LeaderboardSchema],
    ['ladder.json', LadderSchema],
    ['feed.json', FeedSchema],
    ['reviews.json', ReviewsSchema],
    ['news.json', CatalogNewsSchema],
    ['trade-offers.json', TradeOfferListSchema],
    ['providers.json', ProvidersSchema],
    ['error-unauthorized.json', ErrorBodySchema],
  ];
  it.each(cases)('%s', (file, schema) => {
    const r = schema.safeParse(fixture(file));
    expect(r.error).toBeUndefined();
    expect(r.success).toBe(true);
  });

  it('keeps unknown fields (loose objects)', () => {
    const c = CharacterListSchema.parse([{ ...card(1), brandNewField: 42 }]);
    expect((c[0] as Record<string, unknown>).brandNewField).toBe(42);
  });

  it('accepts packs whose pity rarity is null (observed live)', () => {
    const packs = fixture<Array<Record<string, unknown>>>('packs.json');
    expect(packs.some((p) => (p.rates as { pity?: { rarity: unknown } })?.pity?.rarity === null)).toBe(true);
  });
});

describe('schemas reject wrong shapes', () => {
  it('rejects an unknown rarity', () => {
    expect(CharacterListSchema.safeParse([card(1, 'X')]).success).toBe(false);
  });
  it('rejects a listing page without items', () => {
    expect(ListingPageSchema.safeParse({ total: 3 }).success).toBe(false);
  });
  it('rejects /me without chakra', () => {
    const { chakra: _c, ...rest } = ME;
    expect(MeSchema.safeParse(rest).success).toBe(false);
  });
  it('rejects an open result without cards', () => {
    expect(OpenResultSchema.safeParse({ user: ME, cards: [] }).success).toBe(false);
  });
});

describe('inferred authenticated schemas', () => {
  it('parse the shapes the site frontend consumes', () => {
    expect(OpenResultSchema.parse(openResult(900)).cards).toHaveLength(2);
    expect(OpenManyResultSchema.parse({ results: [openResult(900)], stopped: { code: 'guest_limit', message: 'x' } }).stopped?.code).toBe(
      'guest_limit',
    );
    const claim = ClaimResultSchema.parse({
      progress: { claimable: 0, resets: { nextDaily: '2026-10-11T04:00:00.000Z', nextWeekly: null } },
      user: ME,
      gained: { chakra: 50 },
    });
    expect(claim.gained.grants).toEqual({});
  });
});

describe('session schemas confirmed against a real account (shapes from `api verify --shapes`)', () => {
  it('parse /me with the extra fields', () => {
    const me = MeSchema.parse(fixture('me.json'));
    expect(me.chakraHeld).toBe(300);
    expect(me.nextFreeAt).toBe('2026-10-10T19:00:00.000Z');
    expect(me.pity).toBe(120);
  });
  it('parse collection entries, pack state, my market and market access', () => {
    expect(CollectionEntrySchema.parse({ characterId: 1, qty: 3, listable: 1, sellBlock: null, firstAt: '2026-10-01T00:00:00Z', locked: 1, resaleLocked: 0, resaleUntil: null }).locked).toBe(1);
    expect(PackStateSchema.parse({ limits: { daily: { left: 1 } }, day: '2026-10-10', featuredPity: { 'banner-jjk': {} } }).limits.daily?.left).toBe(1);
    expect(MyMarketSchema.parse({ listings: [{}], bids: [], buyOrders: [], holds: [{}] }).holds).toHaveLength(1);
    expect(MarketAccessSchema.parse({ allowed: true, reasons: [], discord: true, accountAgeDays: 40, boostersOpened: 140, gating: true }).allowed).toBe(true);
  });
  it('wallet shows reserved chakra, next free pack and pity', () => {
    const w = summariseWallet(MeSchema.parse(fixture('me.json')), ConfigSchema.parse(fixture('config.json')));
    expect(w).toMatchObject({ chakra: 1200, chakraHeld: 300, freePacks: 4, freePacksMax: 15, nextFreeAt: '2026-10-10T19:00:00.000Z' });
    expect(w.pity).toEqual({ count: 120, threshold: 250, rarity: 'M' });
    const full = summariseWallet(MeSchema.parse({ ...fixture<object>('me.json'), freePacks: 15 }), ConfigSchema.parse(fixture('config.json')));
    expect(full.nextFreeAt).toBeNull();
  });
});
