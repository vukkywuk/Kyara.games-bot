import type { FairPlay } from '../api/schemas/trades.js';

/*
 * Port of the site's fair-play check from its trade dialog. The site shows this verdict
 * before a trade is sent and refuses to send `over`. The bot is stricter: it only sends
 * trades the site calls `fair`, never a `gift` (a lopsided trade that eats into limits).
 */

export interface TradeCards {
  cards: Array<{ characterId: number; qty: number }>;
  chakra: number;
}

export type FairVerdict =
  | { kind: 'fair' }
  | { kind: 'gift'; out: boolean; amount: number }
  | { kind: 'over'; reason: string }
  | { kind: 'unpriced'; missing: number[] };

/** Value of one side in chakra, using the site's reference prices. Null when a card has no price. */
export function sideValue(side: TradeCards, prices: ReadonlyMap<number, number>): number | null {
  let total = side.chakra || 0;
  for (const c of side.cards) {
    const p = prices.get(c.characterId);
    if (p === undefined) return null;
    total += c.qty * p;
  }
  return total;
}

export function fairVerdict(give: TradeCards, want: TradeCards, prices: ReadonlyMap<number, number>, fp: FairPlay): FairVerdict {
  const missing = [...give.cards, ...want.cards].map((c) => c.characterId).filter((id) => !prices.has(id));
  if (missing.length) return { kind: 'unpriced', missing };
  const mine = sideValue(give, prices)!;
  const theirs = sideValue(want, prices)!;
  if (!fp.enabled) return { kind: 'fair' };

  const out = mine >= theirs; // I give more than I get
  const hi = Math.max(mine, theirs);
  const lo = Math.min(mine, theirs);
  const diff = hi - lo;
  const amount = Math.max(0, Math.round(hi - fp.freeRatio * lo));
  if (diff < fp.ignoreBelow || amount === 0) return { kind: 'fair' };

  const left = out ? fp.giveLeft : fp.getLeft;
  const balanceLeft = out ? fp.giveBalanceLeft : fp.getBalanceLeft;
  const receivedLeft = out ? fp.theirReceivedLeft : fp.myReceivedLeft;
  if (amount > left) return { kind: 'over', reason: `over the ${left} chakra of uneven value allowed with this player per ${fp.pairDays * 24} h` };
  if (diff > balanceLeft) return { kind: 'over', reason: `over the ${balanceLeft} chakra balance allowed with this player per ${fp.pairDays * 24} h` };
  if (amount > receivedLeft) return { kind: 'over', reason: `over the ${receivedLeft} chakra that can be received per ${fp.receivedDays * 24} h` };
  return { kind: 'gift', out, amount };
}
