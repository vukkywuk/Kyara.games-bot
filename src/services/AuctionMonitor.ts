import type { Listing, ListingQuery } from '../api/schemas/market.js';
import type { ListingFilter, MarketModule } from '../modules/MarketModule.js';
import { applyListingFilter, listingPrice } from '../modules/MarketModule.js';
import { ActionRefusedError, AmbiguousOutcomeError, HumanVerificationError, KyaraApiError } from '../utils/errors.js';
import type { Logger } from '../utils/logger.js';
import { formatDuration } from '../utils/time.js';
import type { Notifier } from './Notifier.js';

export interface AutoBidPolicy {
  /** Must be true in config AND requested on the command line / monitor. */
  enabled: boolean;
  /** Most chakra this monitor may have committed at once: held by leading bids plus copies won. */
  budget: number;
  /** Your maximum per copy. Kyara bids are proxy bids, so this is sent once as the maximum. */
  maxBid: number;
  /** Only bid when the auction ends within this window (avoids showing your hand early). */
  onlyWithinMs: number;
  /** Stop bidding once this many copies are won or currently led. */
  copies: number;
}

/** A listing this monitor bid on (or that already carried one of your bids). */
export interface TrackedBid {
  id: string;
  name: string;
  /** Your maximum on it (held while leading). */
  amount: number;
  endsAt: string;
  leading: boolean | null;
}

export interface WonCopy {
  id: string;
  name: string;
  /** Final price when Kyara reports it, else your maximum (an upper bound). */
  price: number;
  at: string;
}

export interface AuctionProgress {
  won: WonCopy[];
  tracked: TrackedBid[];
  /** Set after an unclear bid outcome; auto-bidding stays off until the monitor is edited. */
  halted: boolean;
}

export interface AuctionMonitorOptions {
  query: ListingQuery;
  filter: ListingFilter;
  /** Alert when a matching auction ends within this window. */
  endingSoonMs: number;
  maxPages: number;
  autoBid?: AutoBidPolicy;
  /** Checked right before each bid: false once the monitor was stopped or paused. */
  isActive?: () => boolean;
  /** Restores copies won and bids in flight across restarts. */
  progress?: AuctionProgress;
  /** Called whenever the progress changes, so it can be persisted. */
  onProgress?: (p: AuctionProgress) => void;
}

/** Seconds after an auction's end before its result is looked up. */
const SETTLE_MS = 5_000;
const MAX_LOOKUPS_PER_TICK = 10;

/**
 * Watches market listings and emits events. By default it only notifies. Auto-bidding
 * requires explicit opt-in, a budget, a maximum and a copies target, and goes through the
 * same guarded `MarketModule.bid` path as a manual bid.
 *
 * Kyara bids are proxy bids: the server raises your bid for you up to your maximum. So the
 * monitor sends your maximum once per auction (in its final window), follows whether you
 * are still leading, and counts the auctions you win toward the copies target.
 */
export class AuctionMonitor {
  private seen = new Set<string>();
  private warnedEnding = new Set<string>();
  private leading = new Map<string, boolean>();
  private tracked = new Map<string, TrackedBid>();
  private won: WonCopy[] = [];
  private halted = false;
  private reachedNotified = false;
  private passWarned = false;

  constructor(
    private readonly market: MarketModule,
    private readonly notifier: Notifier,
    private readonly log: Logger,
    private readonly opts: AuctionMonitorOptions,
  ) {
    for (const t of opts.progress?.tracked ?? []) this.tracked.set(t.id, { ...t });
    this.won = [...(opts.progress?.won ?? [])];
    this.halted = !!opts.progress?.halted;
  }

  /** Chakra committed: held by bids still leading (or unclear) plus what won copies cost. */
  get reservedChakra(): number {
    let sum = this.won.reduce((a, w) => a + w.price, 0);
    for (const t of this.tracked.values()) if (t.leading !== false) sum += t.amount;
    return sum;
  }

  get copies(): { won: number; leading: number; target: number | null } {
    const leading = [...this.tracked.values()].filter((t) => t.leading !== false).length;
    return { won: this.won.length, leading, target: this.opts.autoBid?.enabled ? this.opts.autoBid.copies : null };
  }

  get progress(): AuctionProgress {
    return { won: [...this.won], tracked: [...this.tracked.values()], halted: this.halted };
  }

  /** Returns how long to wait before the next check when something needs attention sooner. */
  async tick(now = Date.now()): Promise<number | undefined> {
    const { items } = await this.market.searchPages({ sort: 'ending', ...this.opts.query }, this.opts.maxPages);
    const before = JSON.stringify(this.progress);
    await this.settle(items, now);

    const matches = applyListingFilter(items, this.opts.filter, now);
    for (const l of matches) {
      const left = Date.parse(l.endsAt) - now;
      if (!this.seen.has(l.id)) {
        this.seen.add(l.id);
        this.notifier.notify({
          type: 'listing.match',
          title: `${l.character.name} [${l.character.rarity}] ${l.type} at ${listingPrice(l)}`,
          detail: `ends in ${formatDuration(left)} · ${l.bidCount} bids · id ${l.id}`,
          data: { listingId: l.id, characterId: l.character.id, price: listingPrice(l), endsAt: l.endsAt },
        });
      }
      if (l.type === 'auction' && left > 0 && left <= this.opts.endingSoonMs && !this.warnedEnding.has(l.id)) {
        this.warnedEnding.add(l.id);
        this.notifier.notify({
          type: 'auction.ending',
          title: `${l.character.name} ending in ${formatDuration(left)}`,
          detail: `current ${listingPrice(l)}, min next ${l.minNextBid ?? '?'}`,
          data: { listingId: l.id },
        });
      }
      if (l.leading !== null) {
        const was = this.leading.get(l.id);
        if (was === true && l.leading === false) {
          this.notifier.notify({ type: 'auction.outbid', title: `Outbid on ${l.character.name}`, detail: `now ${listingPrice(l)}`, data: { listingId: l.id } });
        }
        this.leading.set(l.id, l.leading);
      }
    }
    await this.autoBid(matches, now);
    if (JSON.stringify(this.progress) !== before) this.opts.onProgress?.(this.progress);
    return this.nextWake(matches, now);
  }

  /** Updates bids from fresh listings, and settles auctions that ended (won or lost). */
  private async settle(items: Listing[], now: number): Promise<void> {
    const byId = new Map(items.map((l) => [l.id, l]));
    // listings that already carry one of your bids (placed by hand or before a restart) count too
    for (const l of items) {
      if (l.type === 'auction' && l.myMaxBid !== null && !this.tracked.has(l.id) && this.matchesWatch(l)) {
        this.tracked.set(l.id, { id: l.id, name: l.character.name, amount: l.myMaxBid, endsAt: l.endsAt, leading: l.leading });
      }
    }
    let lookups = 0;
    for (const t of [...this.tracked.values()]) {
      let l = byId.get(t.id);
      const endedByClock = Date.parse(t.endsAt) + SETTLE_MS <= now;
      if (!l) {
        // not on the scanned pages (ended, or pushed further down): look it up directly, bounded
        if (lookups >= MAX_LOOKUPS_PER_TICK) continue;
        lookups++;
        try {
          l = await this.market.listing(t.id);
        } catch (err) {
          if (err instanceof KyaraApiError && err.status === 404 && endedByClock) {
            // gone after its end: settle on what was last known
            this.finish(t, t.leading === true, null, now);
          }
          continue;
        }
      }
      if (!l) continue;
      t.endsAt = l.endsAt; // late bids can extend an auction
      if (l.myMaxBid !== null) t.amount = l.myMaxBid;
      if (l.leading !== null) t.leading = l.leading;
      const ended = l.status !== 'active' || Date.parse(l.endsAt) <= now;
      if (ended) this.finish(t, l.leading ?? t.leading === true, l.finalPrice ?? l.currentBid ?? null, now);
    }
  }

  private finish(t: TrackedBid, won: boolean, price: number | null, now: number): void {
    this.tracked.delete(t.id);
    if (won) {
      const paid = price ?? t.amount;
      this.won.push({ id: t.id, name: t.name, price: paid, at: new Date(now).toISOString() });
      this.notifier.notify({ type: 'auction.won', title: `Won ${t.name} for ${paid} chakra`, detail: this.copiesLine(), data: { listingId: t.id, price: paid } });
    } else {
      this.notifier.notify({ type: 'auction.lost', title: `Lost ${t.name}`, detail: `someone went above your maximum of ${t.amount}`, data: { listingId: t.id } });
    }
  }

  private async autoBid(matches: Listing[], now: number): Promise<void> {
    const p = this.opts.autoBid;
    if (!p?.enabled || this.halted) return;
    for (const l of matches) {
      if (this.opts.isActive && !this.opts.isActive()) return;
      const { won, leading } = this.copies;
      if (won + leading >= p.copies) {
        if (!this.reachedNotified && won >= p.copies) {
          this.reachedNotified = true;
          this.notifier.notify({ type: 'auction.target', title: `Got ${won} of ${p.copies} copies; auto-bidding stops`, detail: 'Raise the number of copies to keep going.' });
        }
        return;
      }
      if (l.type !== 'auction' || l.isMine || l.leading === true) continue;
      const left = Date.parse(l.endsAt) - now;
      if (left <= 0 || left > p.onlyWithinMs) continue;
      // proxy bid: send the maximum, kept one under the buyout (reaching it means buying instead)
      const max = Math.min(p.maxBid, this.opts.filter.maxPrice ?? Infinity);
      const amount = l.buyoutPrice !== null ? Math.min(max, l.buyoutPrice - 1) : max;
      const min = l.minNextBid ?? listingPrice(l) + 1;
      if (amount < min) continue; // already above your maximum
      if (l.myMaxBid !== null && amount <= l.myMaxBid) continue; // your maximum is already in and was beaten
      const extra = amount - (l.myMaxBid ?? 0);
      if (this.reservedChakra + extra > p.budget) {
        this.log.info(`Auto-bid skipped on ${l.character.name}: would exceed the monitor budget (${this.reservedChakra}/${p.budget}).`);
        continue;
      }
      await this.placeBid(l, amount);
      if (this.halted) return;
    }
  }

  private async placeBid(l: Listing, amount: number): Promise<void> {
    const t: TrackedBid = { id: l.id, name: l.character.name, amount, endsAt: l.endsAt, leading: null };
    try {
      const out = await this.market.bid(l.id, amount, { assumeYes: true });
      if (out.status !== 'succeeded') return;
      this.passWarned = false;
      t.leading = out.result.leading;
      this.tracked.set(l.id, t);
      this.leading.set(l.id, t.leading);
      this.notifier.notify({
        type: t.leading ? 'auction.autobid' : 'auction.outbid',
        title: t.leading ? `Bid up to ${amount} on ${l.character.name}` : `Bid up to ${amount} on ${l.character.name}, already beaten`,
        detail: t.leading ? `leading at ${out.result.listing.currentBid ?? '?'} · ${this.copiesLine()}` : 'someone holds a higher maximum; your chakra is refunded',
        data: { listingId: l.id, amount, leading: t.leading, reserved: this.reservedChakra },
      });
    } catch (err) {
      if (err instanceof ActionRefusedError) {
        this.log.info(`Auto-bid refused on ${l.character.name}: ${err.message}`);
        return;
      }
      if (err instanceof HumanVerificationError) {
        if (!this.passWarned) {
          this.passWarned = true;
          this.notifier.notify({ type: 'auction.needs-pass', title: 'Kyara wants its anti-bot pass to place bids', detail: 'Bids resume while kyara.games is open and visible (the pass is synced from there).' });
        }
        return;
      }
      if (err instanceof AmbiguousOutcomeError) {
        // Count it as held and stop auto-bidding: we do not know what happened.
        this.tracked.set(l.id, t);
        this.halted = true;
        this.notifier.notify({ type: 'auction.autobid.unknown', title: 'Auto-bid outcome unknown; auto-bidding stopped', detail: `${err.message} Check the listing on Kyara, then save the monitor again to resume.` });
        return;
      }
      throw err;
    }
  }

  /** Wake when the next candidate enters its bidding window, or shortly after a leading bid ends. */
  private nextWake(matches: Listing[], now: number): number | undefined {
    const waits: number[] = [];
    const p = this.opts.autoBid;
    if (p?.enabled && !this.halted) {
      for (const l of matches) {
        if (l.type !== 'auction' || l.isMine || l.leading === true) continue;
        const toWindow = Date.parse(l.endsAt) - p.onlyWithinMs - now;
        if (toWindow > 0) waits.push(toWindow + 2_000);
      }
    }
    for (const t of this.tracked.values()) waits.push(Math.max(0, Date.parse(t.endsAt) - now) + SETTLE_MS);
    return waits.length ? Math.min(...waits) : undefined;
  }

  private matchesWatch(l: Listing): boolean {
    const q = this.opts.query;
    return !q.characterId || l.character.id === q.characterId;
  }

  private copiesLine(): string {
    const p = this.opts.autoBid;
    const { won, leading } = this.copies;
    return p?.enabled ? `${won} won, ${leading} leading, target ${p.copies}` : `${won} won`;
  }
}
