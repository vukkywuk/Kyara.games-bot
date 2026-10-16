import type { FairPlay } from '../api/schemas/trades.js';
import type { TradeCards } from './tradeFairness.js';
import { fairVerdict, sideValue } from './tradeFairness.js';

/** Which of my cards the bot may give away (both directions). */
export interface GiveRules {
  /** Copies to keep on top of the one the site always keeps. */
  keep: number;
  /** Rarities the bot may give; empty = all. */
  rarities: string[];
  /** Character ids never given. */
  exclude: number[];
}

export interface SeekRules {
  enabled: boolean;
  /** Ask for a wishlist card worth between these percentages of the card given. */
  wishMinPct: number;
  wishMaxPct: number;
  /** When no wishlist card fits, ask for chakra. */
  allowChakra: boolean;
  /** Chakra asked = reference value × markup %. */
  markupPct: number;
}

export interface OfferRules {
  enabled: boolean;
  payWithCards: boolean;
  payWithChakra: boolean;
  /** Pay between these percentages of the card's reference value. */
  minPayPct: number;
  maxPayPct: number;
  maxChakra: number;
  maxCards: number;
  /** Only ask for characters I do not own yet. */
  onlyMissing: boolean;
}

export interface TradeRules {
  give: GiveRules;
  seek: SeekRules;
  offer: OfferRules;
}

/** A structured chat request: `seek` = they want the character, `offer` = they offer it. */
export interface TradeRequest {
  kind: 'seek' | 'offer';
  messageId: string;
  room: number;
  at: string;
  user: { id: string; pseudo: string };
  character: { id: number; name: string; rarity: string };
}

export interface PlanContext {
  /** My copies that may be given right now (after the kept copies, locks and reservations). */
  spare: ReadonlyMap<number, number>;
  rarityOf: (characterId: number) => string | undefined;
  owned: ReadonlySet<number>;
  wishlist: ReadonlySet<number>;
  /** Their tradeable copies, by character id. */
  theirAvailable: ReadonlyMap<number, number>;
  /** What they own (null when unknown). */
  theirOwned: ReadonlySet<number> | null;
  /** Reference values (site fair-play prices). */
  prices: ReadonlyMap<number, number>;
  fairPlay: FairPlay;
  /** Chakra the bot may still commit (balance and budget). */
  chakraAvailable: number;
}

export type TradePlan = { ok: true; give: TradeCards; want: TradeCards; summary: string } | { ok: false; reason: string };

/** Spare copies by the site's rule (`qty − locked − resaleLocked − 1`), minus the extra copies to keep. */
export function spareCopies(e: { qty: number; locked?: number; resaleLocked?: number }, keep: number): number {
  return Math.max(0, e.qty - (e.locked ?? 0) - (e.resaleLocked ?? 0) - 1 - Math.max(0, keep));
}

export function mayGive(id: number, ctx: Pick<PlanContext, 'spare' | 'rarityOf'>, rules: GiveRules): boolean {
  if ((ctx.spare.get(id) ?? 0) < 1 || rules.exclude.includes(id)) return false;
  const r = ctx.rarityOf(id);
  return !rules.rarities.length || (r !== undefined && rules.rarities.includes(r));
}

/** Character ids whose reference value the plan needs (fetched in batches before planning). */
export function idsToPrice(req: TradeRequest, ctx: Pick<PlanContext, 'spare' | 'rarityOf' | 'wishlist' | 'theirAvailable'>, rules: TradeRules): number[] {
  const ids = new Set([req.character.id]);
  if (req.kind === 'seek') {
    for (const [id, n] of ctx.theirAvailable) if (n > 0 && ctx.wishlist.has(id)) ids.add(id);
  } else if (rules.offer.payWithCards) {
    for (const id of ctx.spare.keys()) if (mayGive(id, ctx, rules.give)) ids.add(id);
  }
  return [...ids];
}

const one = (characterId: number) => ({ cards: [{ characterId, qty: 1 }], chakra: 0 });

export function planTrade(req: TradeRequest, ctx: PlanContext, rules: TradeRules): TradePlan {
  return req.kind === 'seek' ? planSeek(req, ctx, rules) : planOffer(req, ctx, rules);
}

function checked(give: TradeCards, want: TradeCards, ctx: PlanContext, summary: string): TradePlan {
  const v = fairVerdict(give, want, ctx.prices, ctx.fairPlay);
  if (v.kind === 'fair') return { ok: true, give, want, summary };
  if (v.kind === 'unpriced') return { ok: false, reason: 'no reference price for a card' };
  if (v.kind === 'over') return { ok: false, reason: `fair play: ${v.reason}` };
  return { ok: false, reason: `fair play: the site would count this as a ${v.amount} chakra gift` };
}

/** They want X: give one spare X for a wishlist card of theirs, else for chakra. */
function planSeek(req: TradeRequest, ctx: PlanContext, rules: TradeRules): TradePlan {
  const x = req.character.id;
  if (!rules.seek.enabled) return { ok: false, reason: 'answering seekers is off' };
  if (!mayGive(x, ctx, rules.give)) return { ok: false, reason: (ctx.spare.get(x) ?? 0) < 1 ? 'no spare copy' : 'card not allowed to be given' };
  const vx = ctx.prices.get(x);
  if (vx === undefined) return { ok: false, reason: 'no reference price' };

  const lo = (vx * rules.seek.wishMinPct) / 100;
  const hi = (vx * rules.seek.wishMaxPct) / 100;
  let best: { id: number; v: number } | null = null;
  for (const [id, n] of ctx.theirAvailable) {
    if (n < 1 || !ctx.wishlist.has(id)) continue;
    const v = ctx.prices.get(id);
    if (v === undefined || v < lo || v > hi) continue;
    if (!best || v > best.v || (v === best.v && id < best.id)) best = { id, v };
  }
  if (best) {
    const plan = checked(one(x), one(best.id), ctx, `give ${req.character.name}, get wishlist card #${best.id}`);
    if (plan.ok) return plan;
  }
  if (!rules.seek.allowChakra) return { ok: false, reason: 'no wishlist card of theirs fits, and asking for chakra is off' };
  const ask = Math.max(1, Math.round((vx * rules.seek.markupPct) / 100));
  return checked(one(x), { cards: [], chakra: ask }, ctx, `give ${req.character.name} for ${ask} chakra`);
}

/** They offer X (on my wishlist): pay with spare cards they lack, else with chakra. */
function planOffer(req: TradeRequest, ctx: PlanContext, rules: TradeRules): TradePlan {
  const x = req.character.id;
  const o = rules.offer;
  if (!o.enabled) return { ok: false, reason: 'answering offers is off' };
  if (!ctx.wishlist.has(x)) return { ok: false, reason: 'not on my wishlist' };
  if (o.onlyMissing && ctx.owned.has(x)) return { ok: false, reason: 'already owned' };
  if ((ctx.theirAvailable.get(x) ?? 0) < 1) return { ok: false, reason: 'they have no tradeable copy' };
  const vx = ctx.prices.get(x);
  if (vx === undefined) return { ok: false, reason: 'no reference price' };
  const lo = (vx * o.minPayPct) / 100;
  const hi = (vx * o.maxPayPct) / 100;

  if (o.payWithCards) {
    const cards = pickCards(ctx, rules.give, lo, hi, vx, Math.max(1, o.maxCards));
    if (cards) {
      const give = { cards: cards.map((id) => ({ characterId: id, qty: 1 })), chakra: 0 };
      const plan = checked(give, one(x), ctx, `get ${req.character.name} for ${cards.length} spare card${cards.length > 1 ? 's' : ''}`);
      if (plan.ok) return plan;
    }
  }
  if (!o.payWithChakra) return { ok: false, reason: 'no spare cards of the right value, and paying chakra is off' };
  const pay = Math.min(Math.round(vx), o.maxChakra, Math.floor(ctx.chakraAvailable));
  if (pay < lo || pay <= 0) return { ok: false, reason: `would need ${Math.ceil(lo)} chakra, the limits allow ${Math.max(0, pay)}` };
  return checked({ cards: [], chakra: pay }, one(x), ctx, `get ${req.character.name} for ${pay} chakra`);
}

/**
 * One spare card whose value is in [lo, hi] (closest to the target), else up to `max` cards
 * adding up into that range. Cards they do not own come first: a trade is likelier accepted.
 */
function pickCards(ctx: PlanContext, give: GiveRules, lo: number, hi: number, target: number, max: number): number[] | null {
  const pool = [...ctx.spare.keys()]
    .filter((id) => mayGive(id, ctx, give) && ctx.prices.has(id))
    .map((id) => ({ id, v: ctx.prices.get(id)!, fresh: ctx.theirOwned ? !ctx.theirOwned.has(id) : true }))
    .filter((c) => c.v > 0 && c.v <= hi)
    .sort((a, b) => Number(b.fresh) - Number(a.fresh) || b.v - a.v || a.id - b.id);

  const singles = pool.filter((c) => c.v >= lo).sort((a, b) => Number(b.fresh) - Number(a.fresh) || Math.abs(a.v - target) - Math.abs(b.v - target) || a.id - b.id);
  if (singles.length) return [singles[0]!.id];
  if (max < 2) return null;

  const chosen: number[] = [];
  let total = 0;
  for (const c of pool) {
    if (chosen.length >= max) break;
    if (total + c.v > hi) continue;
    chosen.push(c.id);
    total += c.v;
    if (total >= lo) return chosen;
  }
  return null;
}

export { sideValue };
