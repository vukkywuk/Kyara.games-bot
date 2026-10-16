import type { Me, PackState } from '../api/schemas/account.js';
import type { Pack } from '../api/schemas/public.js';

/*
 * Port of the site's own pack-cost rules (client chunk "D_eG9lV2"). Keeping the exact
 * rules lets the bot show the real cost before opening, and pass the same `maxChakra`
 * ceiling the site passes, so the server refuses (`cost_changed`) rather than overcharging.
 */

export type PackAccessKind = 'grant' | 'free' | 'bonus' | 'chakra' | 'limited' | 'locked' | 'used';

export interface PackAccess {
  kind: PackAccessKind;
  /** Chakra cost of opening one pack right now. */
  chakra: number;
  openable: boolean;
  reason: string;
  /** Opens left today for packs with a daily limit, else null. */
  dailyLeft: number | null;
}

type Wallet = Pick<Me, 'chakra' | 'freePacks' | 'bonusPacks' | 'grants'>;

export const packChakraPrice = (p: Pack): number => p.chakraPrice ?? (p.price || 150);
export const packUsesFreePacks = (p: Pack): boolean => p.usesFreePacks ?? p.price === 0;

export function isScheduledNow(p: Pack, now: number): boolean {
  return !p.schedule || (now >= Date.parse(p.schedule.start) && now < Date.parse(p.schedule.end));
}

export function packAccess(pack: Pack, me: Wallet | null, state: PackState | null, now = Date.now()): PackAccess {
  const granted = me?.grants?.[pack.id] ?? 0;
  if (granted > 0) return { kind: 'grant', chakra: 0, openable: true, reason: `granted ×${granted}`, dailyLeft: null };
  if (pack.grantOnly) return { kind: 'locked', chakra: 0, openable: false, reason: 'reward only', dailyLeft: null };
  if (!isScheduledNow(pack, now)) return { kind: 'locked', chakra: 0, openable: false, reason: 'not available now', dailyLeft: null };

  const dailyLeft = pack.limit ? (state?.limits[pack.id]?.left ?? pack.limit.perDay) : null;
  if (dailyLeft !== null && dailyLeft <= 0) return { kind: 'used', chakra: 0, openable: false, reason: 'daily limit used', dailyLeft };

  const free = me?.freePacks ?? 0;
  const bonus = me?.bonusPacks ?? 0;
  if (packUsesFreePacks(pack) && free > 0) return { kind: 'free', chakra: 0, openable: true, reason: `${free} free left`, dailyLeft };
  if (packUsesFreePacks(pack) && bonus > 0) return { kind: 'bonus', chakra: 0, openable: true, reason: `${bonus} bonus left`, dailyLeft };

  const price = packChakraPrice(pack);
  if (price > 0) return { kind: 'chakra', chakra: price, openable: true, reason: `${price} chakra`, dailyLeft };
  return { kind: 'limited', chakra: 0, openable: true, reason: pack.limit?.perDay === 1 ? 'free, once per day' : 'free', dailyLeft };
}

export interface OpenQuote {
  count: number;
  fromGrants: number;
  fromFree: number;
  paid: number;
  /** Total chakra spent for `count` packs. */
  chakra: number;
}

/** Cost of opening `count` packs: grants first, then free/bonus packs, then chakra. */
export function quoteOpen(pack: Pack, me: Wallet | null, count: number): OpenQuote {
  let left = count;
  const take = (n: number): number => {
    const t = Math.min(left, Math.max(0, n));
    left -= t;
    return t;
  };
  const fromGrants = take(me?.grants?.[pack.id] ?? 0);
  const fromFree = packUsesFreePacks(pack) ? take((me?.freePacks ?? 0) + (me?.bonusPacks ?? 0)) : 0;
  const paid = left;
  return { count, fromGrants, fromFree, paid, chakra: paid * packChakraPrice(pack) };
}

/** How many packs could be opened right now, capped at `cap`. */
export function maxOpenable(pack: Pack, me: Wallet | null, cap: number): number {
  if (!me) return 0;
  const freeish = (me.grants?.[pack.id] ?? 0) + (packUsesFreePacks(pack) ? (me.freePacks ?? 0) + (me.bonusPacks ?? 0) : 0);
  const price = packChakraPrice(pack);
  const affordable = price > 0 ? Math.floor(Math.max(0, me.chakra) / price) : cap;
  return Math.max(0, Math.min(cap, freeish + affordable));
}
