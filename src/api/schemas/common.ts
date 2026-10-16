import { z } from 'zod';

/**
 * Schemas are "loose": unknown fields are kept (the site evolves quickly) but every
 * field the bot relies on is validated. Schemas marked CONFIRMED were checked against
 * live responses; INFERRED ones were derived from the site's frontend code because
 * they need an authenticated session (see docs/api-reference.md).
 */

export const RARITIES = ['C', 'U', 'R', 'E', 'L', 'M'] as const;
export const RaritySchema = z.enum(RARITIES);
export type Rarity = z.infer<typeof RaritySchema>;

export const RARITY_LABEL: Record<Rarity, string> = {
  C: 'Common',
  U: 'Uncommon',
  R: 'Rare',
  E: 'Epic',
  L: 'Legendary',
  M: 'Mythic',
};

export const rarityRank = (r: string): number => RARITIES.indexOf(r as Rarity);

/** CONFIRMED: GET /api/characters (array), /api/characters/:id, nested in listings. */
export const CharacterSchema = z.looseObject({
  id: z.number().int(),
  name: z.string(),
  native: z.string().nullish(),
  image: z.string().nullish(),
  favourites: z.number(),
  num: z.string(),
  pow: z.number(),
  rank: z.number(),
  rarity: RaritySchema,
  series: z.string(),
  aura: z.number(),
});
export type Character = z.infer<typeof CharacterSchema>;

/** Server error body: `{ error: "code", message: "human text" }`. CONFIRMED. */
export const ErrorBodySchema = z.looseObject({
  error: z.string(),
  message: z.string().optional(),
});

/** ISO timestamp kept as string; parse with Date.parse when needed. */
export const IsoDate = z.string().refine((s) => !Number.isNaN(Date.parse(s)), 'expected ISO date');
