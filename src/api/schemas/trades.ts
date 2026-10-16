import { z } from 'zod';
import { IsoDate } from './common.js';
import { MeSchema } from './account.js';

const UserRef = z.looseObject({ id: z.string(), pseudo: z.string() });

/**
 * CONFIRMED: a chat message's card attachment. `tag` is what the poster means:
 * `seek` = "Anyone have it?" (they want the character), `trade` = "Available for a trade" (they offer it).
 */
export const ChatCardAttachmentSchema = z.looseObject({
  kind: z.literal('card'),
  tag: z.string(),
  character: z.looseObject({ id: z.number().int(), name: z.string(), rarity: z.string() }),
});
export type ChatCardAttachment = z.infer<typeof ChatCardAttachmentSchema>;

/** CONFIRMED: items of GET /api/market/chat. Other attachment kinds (listings…) stay loose. */
export const ChatMessageSchema = z.looseObject({
  id: z.string(),
  text: z.string(),
  room: z.number().int(),
  createdAt: IsoDate,
  author: UserRef,
  attachment: z.looseObject({ kind: z.string() }).nullish(),
});
export type ChatMessage = z.infer<typeof ChatMessageSchema>;

export const ChatPageSchema = z.looseObject({ items: z.array(ChatMessageSchema), hasMore: z.boolean().optional() });
export type ChatPage = z.infer<typeof ChatPageSchema>;

/** CONFIRMED: GET /api/market/chat/rooms. */
export const ChatRoomsSchema = z.looseObject({
  capacity: z.number().optional(),
  rooms: z.array(z.looseObject({ room: z.number().int(), count: z.number().optional() })),
});

export const TradeSideSchema = z.looseObject({
  cards: z.array(z.looseObject({ characterId: z.number().int(), qty: z.number().int() })).default([]),
  chakra: z.number().default(0),
});
export type TradeSide = z.infer<typeof TradeSideSchema>;

/** CONFIRMED: items of GET /api/me/trades (`incoming` / `outgoing`). Trades expire after 48 h server-side. */
export const TradeSchema = z.looseObject({
  id: z.string(),
  from: UserRef,
  to: UserRef,
  give: TradeSideSchema,
  want: TradeSideSchema,
  message: z.string().nullish(),
  /** Observed: pending, accepted, declined, cancelled (expired is assumed). */
  status: z.string(),
  offerId: z.string().nullish(),
  createdAt: IsoDate,
  expiresAt: IsoDate.nullish(),
  messages: z.number().optional(),
});
export type Trade = z.infer<typeof TradeSchema>;

export const MyTradesSchema = z.looseObject({
  incoming: z.array(TradeSchema).default([]),
  outgoing: z.array(TradeSchema).default([]),
});
export type MyTrades = z.infer<typeof MyTradesSchema>;

/** CONFIRMED: GET /api/trades/available/:userId — that user's tradeable copies. */
export const TradeableSchema = z.array(z.looseObject({ characterId: z.number().int(), n: z.number().int() }));

/** CONFIRMED: GET /api/trades/owned/:userId — character ids that user owns. */
export const OwnedIdsSchema = z.array(z.number().int());

/** CONFIRMED: GET /api/fair-play/with/:userId — the limits the site checks before sending a trade. */
export const FairPlaySchema = z.looseObject({
  enabled: z.boolean(),
  freeRatio: z.number().default(2),
  ignoreBelow: z.number().default(0),
  receivedDays: z.number().default(0),
  pairDays: z.number().default(0),
  giveLeft: z.number().default(0),
  getLeft: z.number().default(0),
  giveBalanceLeft: z.number().default(0),
  getBalanceLeft: z.number().default(0),
  myReceivedLeft: z.number().default(0),
  theirReceivedLeft: z.number().default(0),
});
export type FairPlay = z.infer<typeof FairPlaySchema>;

/** CONFIRMED: GET /api/fair-play/prices?ids= — the reference value of each character, in chakra. */
export const FairPricesSchema = z.record(z.string(), z.number());

/** INFERRED: POST /api/trades returns at least `{ user }` (the site reads `e.user`). */
export const ProposeResultSchema = z.looseObject({ user: MeSchema, trade: TradeSchema.optional() });
export type ProposeResult = z.infer<typeof ProposeResultSchema>;

/** INFERRED: POST /api/trades/:id/cancel returns at least `{ user }`. */
export const TradeActionResultSchema = z.looseObject({ user: MeSchema.optional() });

export interface ProposeBody {
  toUserId: string;
  give: { cards: Array<{ characterId: number; qty: number }>; chakra: number };
  want: { cards: Array<{ characterId: number; qty: number }>; chakra: number };
  message?: string;
}
