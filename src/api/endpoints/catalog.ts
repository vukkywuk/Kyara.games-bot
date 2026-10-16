import type { KyaraHttpClient } from '../KyaraHttpClient.js';
import {
  CatalogNewsSchema,
  ChangelogSchema,
  CharacterDetailSchema,
  CharacterListSchema,
  ConfigSchema,
  FeedSchema,
  HealthSchema,
  HeritageListSchema,
  LADDER_KEYS,
  LadderSchema,
  LeaderboardSchema,
  NoticeSchema,
  PackCharacterIdsSchema,
  PackListSchema,
  ProvidersSchema,
  RatesSchema,
  ReviewsSchema,
} from '../schemas/public.js';
import type { LadderKey } from '../schemas/public.js';
import { UsageError } from '../../utils/errors.js';

/** Public, read-only endpoints (no session needed). All CONFIRMED live. */
export class CatalogEndpoints {
  constructor(private readonly http: KyaraHttpClient) {}

  health = () => this.http.get('/health', HealthSchema);
  config = () => this.http.get('/config', ConfigSchema);
  providers = () => this.http.get('/auth/providers', ProvidersSchema);
  notice = () => this.http.get('/notice', NoticeSchema);

  characters = () => this.http.get('/characters', CharacterListSchema);
  character = (id: number) => this.http.get(`/characters/${positiveInt(id)}`, CharacterDetailSchema);
  heritage = () => this.http.get('/characters/heritage', HeritageListSchema);
  catalogNews = () => this.http.get('/characters/news', CatalogNewsSchema);

  packs = () => this.http.get('/packs', PackListSchema);
  packCharacterIds = (packId: string) =>
    this.http.get(`/packs/${encodeURIComponent(packId)}/characters`, PackCharacterIdsSchema);
  rates = (packId?: string) => this.http.get('/rates', RatesSchema, { query: { pack: packId } });

  leaderboard = () => this.http.get('/leaderboard', LeaderboardSchema);
  ladder = (by: LadderKey, opts: { q?: string; me?: string } = {}) => {
    if (!LADDER_KEYS.includes(by)) throw new UsageError(`Unknown ladder "${by}". Use one of: ${LADDER_KEYS.join(', ')}`);
    return this.http.get('/leaderboard/ladder', LadderSchema, { query: { by, me: opts.me, q: opts.q } });
  };
  feed = () => this.http.get('/feed', FeedSchema);
  reviews = () => this.http.get('/feedback/reviews', ReviewsSchema);
  changelog = () => this.http.get('/changelog', ChangelogSchema);
}

export function positiveInt(n: number): number {
  if (!Number.isInteger(n) || n <= 0) throw new UsageError(`Expected a positive integer id, got ${n}`);
  return n;
}
