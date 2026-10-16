import type { Rarity } from './types';

/** Kyara's own rarity system: colour, seal kanji (from the site), and English name. */
export const RARITY: Record<Rarity, { color: string; kanji: string; name: string; rank: number }> = {
  C: { color: 'var(--color-r-c)', kanji: '常', name: 'Common', rank: 0 },
  U: { color: 'var(--color-r-u)', kanji: '珍', name: 'Uncommon', rank: 1 },
  R: { color: 'var(--color-r-r)', kanji: '稀', name: 'Rare', rank: 2 },
  E: { color: 'var(--color-r-e)', kanji: '叙', name: 'Epic', rank: 3 },
  L: { color: 'var(--color-r-l)', kanji: '伝', name: 'Legendary', rank: 4 },
  M: { color: 'var(--color-r-m)', kanji: '神', name: 'Mythic', rank: 5 },
};

export const RARITY_ORDER: Rarity[] = ['M', 'L', 'E', 'R', 'U', 'C'];
