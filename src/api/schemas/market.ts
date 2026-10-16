import { z } from 'zod';
import { CharacterSchema, IsoDate } from './common.js';
import { PriceStatsSchema } from './public.js';
import { MeSchema } from './account.js';

/** CONFIRMED: items of GET /api/market/listings and GET /api/market/listings/:id. */
export const ListingSchema = z.looseObject({
  id: z.string(),
  seller: z.looseObject({ id: z.string(), pseudo: z.string() }),
  character: CharacterSchema,
  type: z.enum(['auction', 'fixed']),
  /** Starting price for auctions, sale price for fixed listings. */
  price: z.number(),
  buyoutPrice: z.number().nullable(),
  currentBid: z.number().nullable(),
  minNextBid: z.number().nullable(),
  bidCount: z.number(),
  createdAt: IsoDate,
  endsAt: IsoDate,
  status: z.string(),
  finalPrice: z.number().nullable(),
  isMine: z.boolean(),
  /** Only meaningful with a session: our proxy-bid ceiling on this listing. */
  myMaxBid: z.number().nullable(),
  /** Only meaningful with a session: whether we currently lead the auction. */
  leading: z.boolean().nullable(),
  prices: PriceStatsSchema.optional(),
});
export type Listing = z.infer<typeof ListingSchema>;

export const ListingPageSchema = z.looseObject({
  items: z.array(ListingSchema),
  total: z.number(),
});
export type ListingPage = z.infer<typeof ListingPageSchema>;

/** CONFIRMED, including server-side validation messages for sort and pageSize. */
export const LISTING_SORTS = ['ending', 'newest', 'price_asc', 'price_desc'] as const;
export type ListingSort = (typeof LISTING_SORTS)[number];
export const LISTING_MAX_PAGE_SIZE = 50;

export const ListingQuerySchema = z
  .object({
    q: z.string().trim().min(1).optional(),
    rarity: z.enum(['C', 'U', 'R', 'E', 'L', 'M']).optional(),
    series: z.string().trim().min(1).optional(),
    type: z.enum(['auction', 'fixed']).optional(),
    characterId: z.number().int().positive().optional(),
    sort: z.enum(LISTING_SORTS).optional(),
    page: z.number().int().min(1).optional(),
    pageSize: z.number().int().min(1).max(LISTING_MAX_PAGE_SIZE).optional(),
  })
  .strict();
export type ListingQuery = z.infer<typeof ListingQuerySchema>;

export const PriceHistorySchema = PriceStatsSchema.extend({
  lastSales: z.array(z.looseObject({ price: z.number(), at: z.string().optional() })).default([]),
});

/** CONFIRMED: GET /api/market/buy-orders?characterId= (aggregated order book). */
export const OrderBookSchema = z.array(z.looseObject({ price: z.number(), qty: z.number() }));

/** CONFIRMED: GET /api/trades/offers. */
export const TradeOfferSchema = z.looseObject({
  id: z.string(),
  user: z.looseObject({ id: z.string(), pseudo: z.string() }),
  characterId: z.number(),
  wantIds: z.array(z.number()),
  counterOk: z.boolean().optional(),
  status: z.string(),
  createdAt: IsoDate,
  expiresAt: IsoDate.nullish(),
});
export const TradeOfferListSchema = z.array(TradeOfferSchema);

/** CONFIRMED (session): POST /api/market/listings/:id/bid returns `{ user, listing, leading }`. */
export const BidResultSchema = z.looseObject({
  user: MeSchema,
  listing: ListingSchema.partial().extend({ currentBid: z.number().nullable().optional() }),
  leading: z.boolean(),
});
export type BidResult = z.infer<typeof BidResultSchema>;

/** INFERRED: POST /api/market/listings/:id/buy returns at least `{ user }`. */
export const BuyResultSchema = z.looseObject({ user: MeSchema });
export type BuyResult = z.infer<typeof BuyResultSchema>;

/** CONFIRMED: GET /api/me/market. Item shapes are not yet pinned down, so they stay loose. */
export const MyMarketSchema = z.looseObject({
  listings: z.array(z.looseObject({})).default([]),
  bids: z.array(z.looseObject({})).default([]),
  buyOrders: z.array(z.looseObject({})).default([]),
  holds: z.array(z.looseObject({})).default([]),
});
export type MyMarket = z.infer<typeof MyMarketSchema>;

/** CONFIRMED: GET /api/me/market/access. `reasons` explains a refusal (shown verbatim by the site). */
export const MarketAccessSchema = z.looseObject({
  allowed: z.boolean(),
  reasons: z.array(z.string()).default([]),
  discord: z.boolean().optional(),
  accountAgeDays: z.number().optional(),
  boostersOpened: z.number().optional(),
  gating: z.boolean().optional(),
});
export type MarketAccess = z.infer<typeof MarketAccessSchema>;
