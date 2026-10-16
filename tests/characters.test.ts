import { describe, expect, it } from 'vitest';
import type { Character } from '../src/api/schemas/common.js';
import { filterCharacters, normalize } from '../src/modules/CharacterModule.js';
import { CharacterModule } from '../src/modules/CharacterModule.js';
import { KyaraApi } from '../src/api/KyaraApi.js';
import { KyaraHttpClient } from '../src/api/KyaraHttpClient.js';
import { silentLogger } from '../src/utils/logger.js';
import { MockTransport, fixture, tempDir } from './helpers.js';

const all = fixture<Character[]>('characters.json');

describe('normalize', () => {
  it('strips accents, case and punctuation', () => {
    expect(normalize('Satoru Gojō!')).toBe('satoru gojo');
    expect(normalize('  Shōnen   Mix ')).toBe('shonen mix');
  });
});

describe('filterCharacters', () => {
  it('finds a name regardless of word order and accents', () => {
    expect(filterCharacters(all, { text: 'Satoru Gojou' }).items[0]?.id).toBe(127691);
    expect(filterCharacters(all, { text: 'gojou satoru' }).items[0]?.id).toBe(127691);
    expect(filterCharacters(all, { text: 'GOJO' }).items.map((c) => c.id)).toContain(127691);
  });

  it('matches the native name', () => {
    expect(filterCharacters(all, { text: '五条悟' }).items[0]?.id).toBe(127691);
  });

  it('filters by id, rarity, series and stats', () => {
    expect(filterCharacters(all, { ids: [127691, 40] }).total).toBe(2);
    const mythics = filterCharacters(all, { rarities: ['M'], limit: 1000 });
    expect(mythics.items.every((c) => c.rarity === 'M')).toBe(true);
    expect(filterCharacters(all, { series: 'jujutsu' }).items.every((c) => /JUJUTSU/i.test(c.series))).toBe(true);
    expect(filterCharacters(all, { minPow: 99, limit: 1000 }).items.every((c) => c.pow >= 99)).toBe(true);
    expect(filterCharacters(all, { minFavourites: 30000, limit: 1000 }).items.every((c) => c.favourites >= 30000)).toBe(true);
  });

  it('sorts with sensible defaults and paginates', () => {
    const byPow = filterCharacters(all, { sort: 'pow', limit: 1000 }).items;
    for (let i = 1; i < byPow.length; i++) expect(byPow[i - 1]!.pow).toBeGreaterThanOrEqual(byPow[i]!.pow);
    const asc = filterCharacters(all, { sort: 'pow', order: 'asc', limit: 1000 }).items;
    expect(asc[0]!.pow).toBeLessThanOrEqual(asc.at(-1)!.pow);
    const p1 = filterCharacters(all, { limit: 5, offset: 0 });
    const p2 = filterCharacters(all, { limit: 5, offset: 5 });
    expect(p1.total).toBe(all.length);
    expect(p1.items).toHaveLength(5);
    expect(p2.items[0]?.id).not.toBe(p1.items[0]?.id);
  });

  it('returns nothing for a non-matching query', () => {
    expect(filterCharacters(all, { text: 'zzzz-not-a-character' }).total).toBe(0);
  });
});

describe('CharacterModule cache', () => {
  it('fetches once and serves later calls from the disk cache', async () => {
    const t = new MockTransport().on('GET /characters', { body: all });
    const http = new KyaraHttpClient({ baseUrl: 'https://k.test', transport: t, credentials: { getToken: () => null, getDeviceId: () => 'd' }, minIntervalMs: 0 });
    const dir = tempDir();
    const m1 = new CharacterModule(new KyaraApi(http), dir, silentLogger);
    expect((await m1.all()).length).toBe(all.length);
    const m2 = new CharacterModule(new KyaraApi(http), dir, silentLogger);
    expect((await m2.search({ text: 'gojo' })).total).toBeGreaterThan(0);
    expect(t.calls('GET /characters')).toHaveLength(1);
    await m2.all({ refresh: true });
    expect(t.calls('GET /characters')).toHaveLength(2);
  });
});
