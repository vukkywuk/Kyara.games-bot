import { z } from 'zod';
import { CharacterSchema, IsoDate, RaritySchema } from './common.js';

// All schemas in this file are CONFIRMED against live, unauthenticated responses.

export const HealthSchema = z.looseObject({
  ok: z.boolean(),
  catalog: z
    .looseObject({ ready: z.boolean(), size: z.number(), fetching: z.boolean().optional() })
    .optional(),
});

export const ProvidersSchema = z.looseObject({
  discord: z.boolean(),
  /** Cloudflare Turnstile site key, or null/absent when Turnstile is disabled. */
  turnstile: z.string().nullish(),
});

export const BoostWindowSchema = z.looseObject({
  id: z.string(),
  label: z.string(),
  start: IsoDate,
  end: IsoDate,
  max: z.number(),
});

export const ConfigSchema = z.looseObject({
  catalogSize: z.number(),
  freePacks: z.looseObject({
    max: z.number(),
    regenHours: z.number(),
    boosts: z.array(BoostWindowSchema).default([]),
  }),
  recycle: z.record(z.string(), z.number()),
  dropWeights: z.record(z.string(), z.number()),
  pity: z.looseObject({ threshold: z.number(), rarity: z.string().nullish() }).nullish(),
  golden: z.looseObject({ every: z.number(), slots: z.array(z.string()) }).nullish(),
  godPackChance: z.number().optional(),
  guestBoosterLimit: z.number().optional(),
  resets: z.looseObject({ timezone: z.string(), dailyHour: z.number(), weeklyDay: z.string() }).optional(),
  referral: z.looseObject({ enabled: z.boolean() }).optional(),
});
export type KyaraSiteConfig = z.infer<typeof ConfigSchema>;

export const CharacterListSchema = z.array(CharacterSchema);

export const DropChanceSchema = z.record(z.string(), z.number());
export const PriceStatsSchema = z.looseObject({
  characterId: z.number(),
  median7d: z.number().nullable(),
  median30d: z.number().nullable(),
  sales7d: z.number(),
  sales30d: z.number(),
  lastPrice: z.number().nullable(),
  lastAt: z.string().nullable(),
});
export type PriceStats = z.infer<typeof PriceStatsSchema>;

export const CharacterDetailSchema = CharacterSchema.extend({
  dropChance: DropChanceSchema.optional(),
  prices: PriceStatsSchema.optional(),
});
export type CharacterDetail = z.infer<typeof CharacterDetailSchema>;

export const HeritageListSchema = z.array(CharacterSchema.extend({ heritage: z.boolean().optional() }));

export const CatalogNewsSchema = z.looseObject({
  id: z.string(),
  at: IsoDate,
  before: z.number(),
  after: z.number(),
  removed: z.number().optional(),
  addedCount: z.number().optional(),
  series: z.array(z.looseObject({ name: z.string(), before: z.number(), after: z.number() })).default([]),
  samples: z.array(CharacterSchema).default([]),
});

export const RarityRateSchema = z.looseObject({
  rarity: RaritySchema,
  label: z.string(),
  pct: z.number(),
  boosterPct: z.number(),
  expectedPerBooster: z.number(),
  perCardBoosterPct: z.number(),
});
export const RatesSchema = z.array(RarityRateSchema);
export type RarityRate = z.infer<typeof RarityRateSchema>;

const SlotRatesSchema = z.looseObject({ min: z.string(), pct: z.record(z.string(), z.number()) });

export const PackSchema = z.looseObject({
  id: z.string(),
  name: z.string(),
  sub: z.string().optional(),
  price: z.number(),
  chakraPrice: z.number().nullish(),
  usesFreePacks: z.boolean().optional(),
  series: z.string().nullish(),
  slots: z.array(z.string()).optional(),
  limit: z.looseObject({ perDay: z.number() }).nullish(),
  schedule: z.looseObject({ start: IsoDate, end: IsoDate }).nullish(),
  grantOnly: z.boolean().optional(),
  featuredPity: z.number().nullish(),
  goldenEligible: z.boolean().optional(),
  rates: z
    .looseObject({
      poolSize: z.number().optional(),
      cardsByRarity: z.record(z.string(), z.number()).optional(),
      slots: z.array(SlotRatesSchema).optional(),
      // Some packs have no pity rarity (observed: `{ threshold, rarity: null }`).
      pity: z.looseObject({ threshold: z.number().nullish(), rarity: z.string().nullish() }).nullish(),
    })
    .optional(),
});
export type Pack = z.infer<typeof PackSchema>;
export const PackListSchema = z.array(PackSchema);

export const PackCharacterIdsSchema = z.array(z.number().int());

export const LeaderboardEntrySchema = z.looseObject({
  id: z.string(),
  pseudo: z.string(),
  owned: z.number(),
  mythics: z.number(),
});
export const LeaderboardSchema = z.array(LeaderboardEntrySchema);

export const LADDER_KEYS = ['collection', 'mythics', 'series', 'achievements'] as const;
export type LadderKey = (typeof LADDER_KEYS)[number];

export const LadderSchema = z.looseObject({
  by: z.string(),
  rows: z.array(
    z.looseObject({
      pos: z.number(),
      id: z.string(),
      pseudo: z.string(),
      owned: z.number(),
      mythics: z.number(),
      points: z.number().optional(),
      series: z.number().optional(),
      achievements: z.number().optional(),
      title: z.string().nullish(),
    }),
  ),
  me: z.unknown().nullable(),
  total: z.number(),
  catalogSize: z.number().optional(),
});
export type Ladder = z.infer<typeof LadderSchema>;

export const FeedEntrySchema = z.looseObject({
  userId: z.string(),
  pseudo: z.string(),
  characterId: z.number(),
  name: z.string(),
  series: z.string(),
  rarity: RaritySchema,
  at: IsoDate,
  godPack: z.boolean().optional(),
});
export const FeedSchema = z.array(FeedEntrySchema);

export const ReviewsSchema = z.looseObject({
  average: z.number(),
  count: z.number(),
  items: z.array(
    z.looseObject({
      id: z.string(),
      rating: z.number(),
      text: z.string().nullable(),
      reply: z.string().nullable(),
      createdAt: IsoDate,
      user: z.looseObject({ id: z.string(), pseudo: z.string() }).nullish(),
    }),
  ),
});

export const ChangelogSchema = z.array(
  z.looseObject({
    id: z.string(),
    title: z.string(),
    items: z.array(z.looseObject({ kind: z.string().optional(), text: z.string() })),
    publishedAt: z.string().nullable(),
  }),
);

export const NoticeSchema = z.looseObject({ text: z.string().nullable() });
