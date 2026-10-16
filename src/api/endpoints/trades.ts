import type { KyaraHttpClient } from '../KyaraHttpClient.js';
import {
  ChatPageSchema,
  ChatRoomsSchema,
  FairPlaySchema,
  FairPricesSchema,
  MyTradesSchema,
  OwnedIdsSchema,
  ProposeResultSchema,
  TradeActionResultSchema,
  TradeableSchema,
} from '../schemas/trades.js';
import type { ProposeBody } from '../schemas/trades.js';
import { UsageError } from '../../utils/errors.js';
import { passHeader } from '../../auth/PassManager.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function assertUuid(id: string, what: string): string {
  if (!UUID.test(id)) throw new UsageError(`${what} must be a UUID, got "${id}"`);
  return id;
}

/** Market chat (read only) and trades. The bot never posts in the chat. */
export class TradeEndpoints {
  constructor(private readonly http: KyaraHttpClient) {}

  chat = (room: number, limit = 50, before?: string) =>
    this.http.get('/market/chat', ChatPageSchema, { auth: 'optional', query: { room, limit, before } });
  chatRooms = () => this.http.get('/market/chat/rooms', ChatRoomsSchema, { auth: 'optional' });
  mine = () => this.http.get('/me/trades', MyTradesSchema, { auth: 'required' });
  available = (userId: string) => this.http.get(`/trades/available/${assertUuid(userId, 'User id')}`, TradeableSchema, { auth: 'required' });
  ownedBy = (userId: string) => this.http.get(`/trades/owned/${assertUuid(userId, 'User id')}`, OwnedIdsSchema, { auth: 'required' });
  fairWith = (userId: string) => this.http.get(`/fair-play/with/${assertUuid(userId, 'User id')}`, FairPlaySchema, { auth: 'required' });
  /** At most 200 ids per call, like the site. */
  fairPrices = (ids: number[]) => this.http.get('/fair-play/prices', FairPricesSchema, { auth: 'required', query: { ids: ids.slice(0, 200).join(',') } });

  // Writes: call through ActionGuard only.
  /** Like the site, sends the anti-bot pass when one is stored. */
  propose = (body: ProposeBody, pass: string | null = null) => this.http.mutate('POST', '/trades', ProposeResultSchema, { body, headers: passHeader(pass) });
  cancel = (tradeId: string) => this.http.mutate('POST', `/trades/${assertUuid(tradeId, 'Trade id')}/cancel`, TradeActionResultSchema);
}
