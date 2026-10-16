import { describe, expect, it } from 'vitest';
import type { Pack } from '../src/api/schemas/public.js';
import { maxOpenable, packAccess, quoteOpen } from '../src/modules/packPricing.js';
import { fixture } from './helpers.js';

const packs = fixture<Pack[]>('packs.json');
const pack = (id: string): Pack => packs.find((p) => p.id === id)!;
const wallet = (o: Partial<{ chakra: number; freePacks: number; bonusPacks: number; grants: Record<string, number> }> = {}) => ({
  chakra: 0,
  freePacks: 0,
  bonusPacks: 0,
  grants: {},
  ...o,
});

describe('packAccess (port of the site rules)', () => {
  it('uses free packs first for packs that accept them', () => {
    expect(packAccess(pack('all'), wallet({ freePacks: 3, chakra: 0 }), null)).toMatchObject({ kind: 'free', chakra: 0, openable: true });
  });
  it('falls back to bonus packs, then chakra', () => {
    expect(packAccess(pack('all'), wallet({ bonusPacks: 1 }), null).kind).toBe('bonus');
    expect(packAccess(pack('all'), wallet({ chakra: 500 }), null)).toMatchObject({ kind: 'chakra', chakra: 150 });
  });
  it('never applies free packs to packs that do not accept them', () => {
    expect(packAccess(pack('top'), wallet({ freePacks: 10 }), null)).toMatchObject({ kind: 'chakra', chakra: 750 });
  });
  it('honours grants and grant-only packs', () => {
    expect(packAccess(pack('seal-mythic'), wallet(), null)).toMatchObject({ kind: 'locked', openable: false });
    expect(packAccess(pack('seal-mythic'), wallet({ grants: { 'seal-mythic': 2 } }), null)).toMatchObject({ kind: 'grant', openable: true });
  });
  it('applies daily limits from /me/packs', () => {
    expect(packAccess(pack('daily'), wallet(), { limits: { daily: { left: 0 } } })).toMatchObject({ kind: 'used', openable: false });
    expect(packAccess(pack('daily'), wallet(), { limits: {} })).toMatchObject({ kind: 'limited', openable: true, dailyLeft: 1 });
  });
  it('locks scheduled packs outside their window', () => {
    const p = pack('banner-jjk');
    const after = Date.parse(p.schedule!.end) + 1000;
    expect(packAccess(p, wallet({ chakra: 9999 }), null, after)).toMatchObject({ kind: 'locked', openable: false });
  });
});

describe('quoteOpen', () => {
  it('consumes grants, then free/bonus, then chakra', () => {
    const p = pack('all');
    expect(quoteOpen(p, wallet({ freePacks: 2, bonusPacks: 1 }), 5)).toEqual({ count: 5, fromGrants: 0, fromFree: 3, paid: 2, chakra: 300 });
    expect(quoteOpen(p, wallet({ freePacks: 10 }), 5).chakra).toBe(0);
    expect(quoteOpen(pack('top'), wallet({ freePacks: 10 }), 2)).toMatchObject({ fromFree: 0, paid: 2, chakra: 1500 });
  });
});

describe('maxOpenable', () => {
  it('counts free packs plus what the balance affords, capped', () => {
    expect(maxOpenable(pack('all'), wallet({ freePacks: 2, chakra: 450 }), 10)).toBe(5);
    expect(maxOpenable(pack('all'), wallet({ freePacks: 20 }), 10)).toBe(10);
    expect(maxOpenable(pack('all'), null, 10)).toBe(0);
  });
});
