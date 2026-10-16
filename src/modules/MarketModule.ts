import type { KyaraApi } from '../api/KyaraApi.js';
import type { PassManager } from '../auth/PassManager.js';
import { withStoredPass } from '../auth/PassManager.js';
import type { BidResult, BuyResult, Listing, ListingPage, ListingQuery, MarketAccess } from '../api/schemas/market.js';
import { LISTING_MAX_PAGE_SIZE } from '../api/schemas/market.js';
import { ActionRefusedError } from '../utils/errors.js';
import type { ActionGuard, GuardOptions, GuardOutcome } from '../services/ActionGuard.js';

export interface ListingFilter {
  /** Applied locally after fetching (the API has no price filter). */
  maxPrice?: number;
  minPrice?: number;
  endingWithinMs?: number;
  excludeMine?: boolean;
  /** Only auctions without a buyout, etc. */
  auctionsOnly?: boolean;
}

/** Effective current price of a listing: current bid, else starting/sale price. */
export const listingPrice = (l: Listing): number => l.currentBid ?? l.price;

/** Price to pay to take a listing immediately, or null when it cannot be bought outright. */
export const immediatePrice = (l: Listing): number | null => (l.type === 'fixed' ? l.price : l.buyoutPrice);

export function applyListingFilter(items: Listing[], f: ListingFilter, now = Date.now()): Listing[] {
  return items.filter((l) => {
    const p = listingPrice(l);
    if (f.maxPrice !== undefined && p > f.maxPrice) return false;
    if (f.minPrice !== undefined && p < f.minPrice) return false;
    if (f.endingWithinMs !== undefined && Date.parse(l.endsAt) - now > f.endingWithinMs) return false;
    if (f.excludeMine && l.isMine) return false;
    if (f.auctionsOnly && l.type !== 'auction') return false;
    return true;
  });
}

export class MarketModule {
  constructor(
    private readonly api: KyaraApi,
    private readonly guard: ActionGuard,
    private readonly passes?: Pick<PassManager, 'cachedPass' | 'invalidate'>,
  ) {}

  search(query: ListingQuery = {}): Promise<ListingPage> {
    return this.api.market.listings(query);
  }

  /** Fetches up to `maxPages` pages (bounded; never walks the whole market). */
  async searchPages(query: ListingQuery, maxPages: number): Promise<{ total: number; items: Listing[] }> {
    const pageSize = query.pageSize ?? LISTING_MAX_PAGE_SIZE;
    const items: Listing[] = [];
    let total = 0;
    for (let page = query.page ?? 1, n = 0; n < Math.max(1, Math.min(maxPages, 20)); page++, n++) {
      const res = await this.api.market.listings({ ...query, page, pageSize });
      total = res.total;
      items.push(...res.items);
      if (res.items.length < pageSize || items.length >= total) break;
    }
    return { total, items };
  }

  listing(id: string): Promise<Listing> {
    return this.api.market.listing(id);
  }

  prices(characterId: number) {
    return this.api.market.prices(characterId);
  }

  orderBook(characterId: number) {
    return this.api.market.orderBook(characterId);
  }

  /**
   * Places a proxy bid. `maxAmount` is reserved from your chakra (refunded if outbid,
   * partially refunded if you win below it), so the balance check uses the full amount.
   */
  async bid(listingId: string, maxAmount: number, opts: GuardOptions = {}): Promise<GuardOutcome<BidResult>> {
    let summary = `Bid up to ${maxAmount} chakra on listing ${listingId.slice(0, 8)}`;
    return this.guard.run<BidResult>(
      {
        kind: 'market.bid',
        key: `market.bid:${listingId}:${maxAmount}`,
        get summary() {
          return summary;
        },
        cost: maxAmount,
        params: { listingId, maxAmount },
        confirm: true,
        repeatCooldownMs: 60_000,
        validate: () => {
          if (!Number.isInteger(maxAmount) || maxAmount <= 0) throw new ActionRefusedError('Bid must be a positive integer.', 'invalid_input');
        },
        preflight: async () => {
          const [l, me, access] = await Promise.all([this.api.market.listing(listingId), this.api.account.me(), this.api.market.access()]);
          checkMarketAccess(access);
          checkBiddable(l, maxAmount, me.chakra);
          summary = `Bid up to ${maxAmount} chakra on ${l.character.name} [${l.character.rarity}] (current ${listingPrice(l)}, min next ${l.minNextBid ?? '?'}, ${l.bidCount} bids, ends ${l.endsAt}) — balance ${me.chakra}`;
        },
        execute: () => withStoredPass(this.passes, (pass) => this.api.market.bid(listingId, maxAmount, pass), 'bid'),
        summarize: (r) => ({ leading: r.leading, currentBid: r.listing.currentBid ?? null, chakraAfter: r.user.chakra }),
      },
      opts,
    );
  }

  /** Buys a fixed-price listing, or an auction at its buyout price. */
  async buy(listingId: string, opts: GuardOptions & { maxPrice?: number } = {}): Promise<GuardOutcome<BuyResult>> {
    let price = opts.maxPrice ?? 0;
    let summary = `Buy listing ${listingId.slice(0, 8)}`;
    return this.guard.run<BuyResult>(
      {
        kind: 'market.buy',
        key: `market.buy:${listingId}`,
        get summary() {
          return summary;
        },
        get cost() {
          return price;
        },
        params: { listingId },
        confirm: true,
        repeatCooldownMs: 24 * 3600_000,
        preflight: async () => {
          const [l, me, access] = await Promise.all([this.api.market.listing(listingId), this.api.account.me(), this.api.market.access()]);
          checkMarketAccess(access);
          price = checkBuyable(l, me.chakra, opts.maxPrice);
          summary = `Buy ${l.character.name} [${l.character.rarity}] for ${price} chakra (${l.type}) — balance ${me.chakra}`;
        },
        execute: () => withStoredPass(this.passes, (pass) => this.api.market.buy(listingId, pass), 'bought'),
        summarize: (r) => ({ price, chakraAfter: r.user.chakra }),
      },
      opts,
    );
  }
}

/** The server gates the market (account age, Discord, boosters opened); refuse early with its reasons. */
export function checkMarketAccess(access: MarketAccess): void {
  if (!access.allowed) {
    const why = access.reasons.length ? access.reasons.join(' ') : 'the market is not open to this account yet';
    throw new ActionRefusedError(`Market locked: ${why}`, 'prerequisite');
  }
}

export function checkBiddable(l: Listing, maxAmount: number, chakra: number, now = Date.now()): void {
  if (l.status !== 'active' || Date.parse(l.endsAt) <= now) throw new ActionRefusedError('This listing has ended.', 'prerequisite');
  if (l.type !== 'auction') throw new ActionRefusedError('This is a fixed-price listing; use `market buy`.', 'prerequisite');
  if (l.isMine) throw new ActionRefusedError('This is your own listing.', 'prerequisite');
  if (l.minNextBid !== null && maxAmount < l.minNextBid) {
    throw new ActionRefusedError(`Bid too low: the minimum next bid is ${l.minNextBid}.`, 'invalid_input');
  }
  if (l.buyoutPrice !== null && maxAmount >= l.buyoutPrice) {
    throw new ActionRefusedError(`Your maximum reaches the buyout price (${l.buyoutPrice}); use \`market buy\` instead.`, 'invalid_input');
  }
  if (l.myMaxBid !== null && maxAmount <= l.myMaxBid) {
    throw new ActionRefusedError(`You already have a maximum of ${l.myMaxBid} on this listing.`, 'duplicate');
  }
  const alreadyHeld = l.myMaxBid ?? 0;
  if (maxAmount - alreadyHeld > chakra) {
    throw new ActionRefusedError(`Not enough chakra: the bid reserves ${maxAmount - alreadyHeld} more, you have ${chakra}.`, 'insufficient_funds');
  }
}

export function checkBuyable(l: Listing, chakra: number, maxPrice?: number, now = Date.now()): number {
  if (l.status !== 'active' || Date.parse(l.endsAt) <= now) throw new ActionRefusedError('This listing has ended.', 'prerequisite');
  if (l.isMine) throw new ActionRefusedError('This is your own listing.', 'prerequisite');
  const price = immediatePrice(l);
  if (price === null) throw new ActionRefusedError('This auction has no buyout price; place a bid instead.', 'prerequisite');
  if (maxPrice !== undefined && price > maxPrice) {
    throw new ActionRefusedError(`Price ${price} is above your limit of ${maxPrice}.`, 'over_budget');
  }
  if (price > chakra) throw new ActionRefusedError(`Not enough chakra: costs ${price}, you have ${chakra}.`, 'insufficient_funds');
  return price;
}
