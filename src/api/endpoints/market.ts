import { z } from 'zod';
import type { KyaraHttpClient } from '../KyaraHttpClient.js';
import {
  BidResultSchema,
  BuyResultSchema,
  ListingPageSchema,
  ListingQuerySchema,
  ListingSchema,
  MarketAccessSchema,
  MyMarketSchema,
  OrderBookSchema,
  PriceHistorySchema,
  TradeOfferListSchema,
} from '../schemas/market.js';
import type { ListingQuery } from '../schemas/market.js';
import { UsageError } from '../../utils/errors.js';
import { passHeader } from '../../auth/PassManager.js';
import { positiveInt } from './catalog.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function assertListingId(id: string): string {
  if (!UUID.test(id)) throw new UsageError(`Listing id must be a UUID, got "${id}"`);
  return id;
}

export class MarketEndpoints {
  constructor(private readonly http: KyaraHttpClient) {}

  // ---- reads (public; a session only adds isMine / myMaxBid / leading) ----
  listings = (query: ListingQuery = {}) => {
    const parsed = ListingQuerySchema.safeParse(query);
    if (!parsed.success) throw new UsageError(`Invalid listing query: ${parsed.error.issues.map((i) => i.message).join('; ')}`);
    return this.http.get('/market/listings', ListingPageSchema, { auth: 'optional', query: parsed.data });
  };
  listing = (id: string) => this.http.get(`/market/listings/${assertListingId(id)}`, ListingSchema, { auth: 'optional' });
  prices = (characterId: number) => this.http.get(`/market/prices/${positiveInt(characterId)}`, PriceHistorySchema);
  orderBook = (characterId: number) =>
    this.http.get('/market/buy-orders', OrderBookSchema, { query: { characterId: positiveInt(characterId) } });
  tradeOffers = () => this.http.get('/trades/offers', TradeOfferListSchema);

  // ---- reads (session) ----
  mine = () => this.http.get('/me/market', MyMarketSchema, { auth: 'required' });
  access = () => this.http.get('/me/market/access', MarketAccessSchema, { auth: 'required' });
  myTrades = () => this.http.get('/me/trades', z.unknown(), { auth: 'required' });

  // ---- state-changing (through ActionGuard only) ----
  /** Proxy bid: `maxAmount` is a ceiling held aside, not necessarily spent. */
  bid = (listingId: string, maxAmount: number, pass: string | null = null) =>
    this.http.mutate('POST', `/market/listings/${assertListingId(listingId)}/bid`, BidResultSchema, { body: { maxAmount }, headers: passHeader(pass) });
  buy = (listingId: string, pass: string | null = null) =>
    this.http.mutate('POST', `/market/listings/${assertListingId(listingId)}/buy`, BuyResultSchema, { headers: passHeader(pass) });
}
