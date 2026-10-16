import { z } from 'zod';
import { CharacterSchema, IsoDate } from './common.js';

/*
 * Session endpoints. GET shapes were CONFIRMED on 2026-10-10 against a real account
 * (`kyara api verify --shapes`); open and claim responses have since been parsed live.
 * The pass response is still INFERRED from the site's client. Only the fields the bot
 * reads are required, so small server changes do not break parsing.
 */

/** GET /api/me — also embedded as `user` in open/claim/bid/buy results. */
export const MeSchema = z.looseObject({
  id: z.string(),
  pseudo: z.string().nullish(),
  chakra: z.number(),
  freePacks: z.number().optional(),
  freePacksMax: z.number().optional(),
  bonusPacks: z.number().optional(),
  /** Granted packs by pack id, e.g. `{ "seal-mythic": 1 }`. */
  grants: z.record(z.string(), z.number()).optional(),
  /** Boosters until the next golden one (1 = next is golden). */
  goldenIn: z.number().nullish(),
  boostersOpened: z.number().optional(),
  /** Chakra reserved by bids / buy orders. Not included in `chakra` (the site shows it as "+ X mis de côté"). */
  chakraHeld: z.number().optional(),
  /** When the next free pack regenerates (only meaningful while below the maximum). */
  nextFreeAt: z.string().nullish(),
  /** Openings counted toward the Mythic pity (see pack `rates.pity.threshold`). */
  pity: z.number().optional(),
  freeBoost: z
    .looseObject({ id: z.string(), label: z.string(), end: z.string(), max: z.number(), regenHours: z.number().optional() })
    .nullish(),
  createdAt: z.string().optional(),
  discord: z.looseObject({ avatar: z.string().nullish() }).nullish(),
  isAdmin: z.boolean().optional(),
  ban: z.unknown().optional(),
  trust: z.unknown().optional(),
});
export type Me = z.infer<typeof MeSchema>;

/** GET /api/me/collection?lean=1 — one entry per owned character. */
export const CollectionEntrySchema = z.looseObject({
  characterId: z.number().int(),
  qty: z.number().int(),
  /** Copies that can be put on the market (excludes copies already listed or locked). */
  listable: z.number().int().optional(),
  sellBlock: z.unknown().optional(),
  firstAt: z.string().nullish(),
  /** Copies set aside (listed, offered in a trade…). */
  locked: z.number().int().optional(),
  /** Copies that cannot be resold yet (72 h after a purchase or trade). */
  resaleLocked: z.number().int().optional(),
  resaleUntil: z.string().nullish(),
});
export type CollectionEntry = z.infer<typeof CollectionEntrySchema>;
export const CollectionSchema = z.array(CollectionEntrySchema);

/** GET /api/me/packs — per-pack daily limits. */
export const PackStateSchema = z.looseObject({
  limits: z.record(z.string(), z.looseObject({ left: z.number() })).default({}),
  day: z.string().optional(),
  featuredPity: z.record(z.string(), z.unknown()).optional(),
});
export type PackState = z.infer<typeof PackStateSchema>;

/** GET /api/me/bootstrap — aggregate used by the site at startup. */
export const BootstrapSchema = z.looseObject({
  me: MeSchema,
  wishlist: z.array(z.number()).optional(),
});

const MissionSchema = z.looseObject({
  id: z.string().optional(),
  label: z.string().optional(),
  description: z.string().optional(),
  progress: z.number().optional(),
  target: z.number().optional(),
  done: z.boolean().optional(),
  claimed: z.boolean().optional(),
  chakra: z.number().optional(),
});

/** GET /api/me/progress — missions, streak, achievements, series rewards. */
export const ProgressSchema = z.looseObject({
  claimable: z.number(),
  resets: z.looseObject({ nextDaily: z.string().nullish(), nextWeekly: z.string().nullish() }),
  daily: z.looseObject({ missions: z.array(MissionSchema).default([]), bonusClaimed: z.boolean().optional() }).nullish(),
  weekly: z.looseObject({ missions: z.array(MissionSchema).default([]), bonusClaimed: z.boolean().optional() }).nullish(),
  streak: z
    .looseObject({ day: z.number().optional(), claimedToday: z.boolean().optional(), nextDay: z.unknown().optional() })
    .nullish(),
  welcome: z.looseObject({ giftClaimed: z.boolean().optional() }).nullish(),
  achievements: z.array(MissionSchema).default([]),
  series: z
    .array(
      z.looseObject({
        series: z.string(),
        size: z.number().optional(),
        total: z.number().optional(),
        claimed: z.boolean().optional(),
      }),
    )
    .default([]),
});
export type Progress = z.infer<typeof ProgressSchema>;

export const CLAIM_KINDS = ['all', 'streak', 'series', 'achievement'] as const;
export type ClaimKind = (typeof CLAIM_KINDS)[number];

/** POST /api/me/progress/claim -> `{ progress, user, gained: { chakra?, bonusPacks?, grants } }`. */
export const ClaimResultSchema = z.looseObject({
  progress: ProgressSchema,
  user: MeSchema,
  gained: z.looseObject({
    chakra: z.number().optional(),
    bonusPacks: z.number().optional(),
    grants: z.record(z.string(), z.number()).default({}),
  }),
});
export type ClaimResult = z.infer<typeof ClaimResultSchema>;

/** A card as returned by a pack opening. */
export const PulledCardSchema = CharacterSchema.extend({
  isNew: z.boolean().optional(),
  wished: z.boolean().optional(),
  featured: z.boolean().optional(),
});
export type PulledCard = z.infer<typeof PulledCardSchema>;

/** POST /api/packs/:id/open */
export const OpenResultSchema = z.looseObject({
  user: MeSchema,
  cards: z.array(PulledCardSchema).min(1),
  godPack: z.boolean().optional(),
  golden: z.boolean().optional(),
});
export type OpenResult = z.infer<typeof OpenResultSchema>;

/** POST /api/packs/:id/open-many */
export const OpenManyResultSchema = z.looseObject({
  results: z.array(OpenResultSchema),
  stopped: z.looseObject({ code: z.string(), message: z.string().optional() }).nullish(),
});
export type OpenManyResult = z.infer<typeof OpenManyResultSchema>;

/** POST /api/auth/pass -> stored by the site as `kyara_pass` = `{ pass, expiresAt }`. */
export const PassSchema = z.looseObject({ pass: z.string().min(1), expiresAt: z.number() });
export type Pass = z.infer<typeof PassSchema>;

export const WishlistSchema = z.array(z.number().int());

export const NotificationsSchema = z.unknown();

export const RecycleResultSchema = z.looseObject({ user: MeSchema.optional() });

export { IsoDate };
