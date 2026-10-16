import type { Character, Rarity } from '../api/schemas/common.js';
import { rarityRank } from '../api/schemas/common.js';

/*
 * Pure character search, shared by the CLI and the web app (no Node imports here).
 */

export const CHARACTER_SORTS = ['rank', 'pow', 'aura', 'favourites', 'name', 'rarity'] as const;
export type CharacterSort = (typeof CHARACTER_SORTS)[number];

export interface CharacterQuery {
  /** Free text matched against name, native name and (optionally) series. Word order does not matter. */
  text?: string;
  ids?: number[];
  series?: string;
  rarities?: Rarity[];
  minPow?: number;
  maxPow?: number;
  minAura?: number;
  maxAura?: number;
  minFavourites?: number;
  sort?: CharacterSort;
  order?: 'asc' | 'desc';
  limit?: number;
  offset?: number;
}

export interface SearchResult<T> {
  total: number;
  items: T[];
}

/** Lowercase, strip accents and punctuation: "Satoru Gojō" → "satoru gojo". */
export function normalize(s: string): string {
  return s
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

function matchScore(c: Character, tokens: string[], phrase: string): number {
  const name = normalize(c.name);
  const native = c.native ? normalize(c.native) : '';
  const hay = `${name} ${native}`;
  if (!tokens.every((t) => hay.includes(t))) return 0;
  if (name === phrase || native === phrase) return 100;
  const reversed = name.split(' ').reverse().join(' ');
  if (reversed === phrase) return 90;
  if (name.startsWith(phrase)) return 70;
  const words = name.split(' ');
  return 40 + 10 * tokens.filter((t) => words.includes(t)).length;
}

export function filterCharacters(all: readonly Character[], q: CharacterQuery): SearchResult<Character> {
  const tokens = q.text ? normalize(q.text).split(' ').filter(Boolean) : [];
  const phrase = tokens.join(' ');
  const series = q.series ? normalize(q.series) : null;
  const ids = q.ids?.length ? new Set(q.ids) : null;
  const rar = q.rarities?.length ? new Set(q.rarities) : null;

  const scored: Array<{ c: Character; score: number }> = [];
  for (const c of all) {
    if (ids && !ids.has(c.id)) continue;
    if (rar && !rar.has(c.rarity)) continue;
    if (series && !normalize(c.series).includes(series)) continue;
    if (q.minPow !== undefined && c.pow < q.minPow) continue;
    if (q.maxPow !== undefined && c.pow > q.maxPow) continue;
    if (q.minAura !== undefined && c.aura < q.minAura) continue;
    if (q.maxAura !== undefined && c.aura > q.maxAura) continue;
    if (q.minFavourites !== undefined && c.favourites < q.minFavourites) continue;
    let score = 1;
    if (tokens.length) {
      score = matchScore(c, tokens, phrase);
      if (!score) continue;
    }
    scored.push({ c, score });
  }

  const dir = q.order === 'desc' ? -1 : 1;
  const sort = q.sort;
  scored.sort((a, b) => {
    if (!sort && tokens.length && a.score !== b.score) return b.score - a.score;
    const key = sort ?? 'rank';
    let d: number;
    if (key === 'name') d = a.c.name.localeCompare(b.c.name);
    else if (key === 'rarity') d = rarityRank(a.c.rarity) - rarityRank(b.c.rarity);
    else d = a.c[key] - b.c[key];
    // Higher pow/aura/favourites/rarity first unless asc requested explicitly.
    const naturalDesc = key === 'pow' || key === 'aura' || key === 'favourites' || key === 'rarity';
    const effective = q.order ? dir : naturalDesc ? -1 : 1;
    return d * effective || a.c.rank - b.c.rank;
  });

  const offset = q.offset ?? 0;
  const limit = q.limit ?? 25;
  return { total: scored.length, items: scored.slice(offset, offset + limit).map((s) => s.c) };
}
