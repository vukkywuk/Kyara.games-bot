import fs from 'node:fs';
import path from 'node:path';
import type { KyaraApi } from '../api/KyaraApi.js';
import type { Character, Rarity } from '../api/schemas/common.js';
import type { CharacterDetail } from '../api/schemas/public.js';
import { CharacterListSchema } from '../api/schemas/public.js';
import type { Logger } from '../utils/logger.js';

export { CHARACTER_SORTS, filterCharacters, normalize } from './characterSearch.js';
export type { CharacterQuery, CharacterSort, SearchResult } from './characterSearch.js';
import type { CharacterQuery, SearchResult } from './characterSearch.js';
import { filterCharacters } from './characterSearch.js';

/**
 * Character catalogue with a disk cache. The full list is ~1.7 MB, so it is fetched
 * at most once per TTL and every search runs locally.
 */
export class CharacterModule {
  private memory: Character[] | null = null;
  private byId: Map<number, Character> | null = null;

  constructor(
    private readonly api: KyaraApi,
    private readonly cacheDir: string | null,
    private readonly log: Logger,
    private readonly ttlMs = 60 * 60_000,
  ) {}

  private get cacheFile(): string | null {
    return this.cacheDir ? path.join(this.cacheDir, 'characters.json') : null;
  }

  async all(opts: { refresh?: boolean } = {}): Promise<Character[]> {
    if (this.memory && !opts.refresh) return this.memory;
    const file = this.cacheFile;
    if (!opts.refresh && file && fs.existsSync(file)) {
      try {
        const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as { fetchedAt: number; items: unknown };
        if (Date.now() - raw.fetchedAt < this.ttlMs) {
          const parsed = CharacterListSchema.safeParse(raw.items);
          if (parsed.success) return this.remember(parsed.data);
        }
      } catch {
        /* corrupt cache: refetch */
      }
    }
    this.log.debug('Fetching the character catalogue');
    const items = await this.api.catalog.characters();
    if (file) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify({ fetchedAt: Date.now(), items }));
    }
    return this.remember(items);
  }

  async search(q: CharacterQuery, opts: { refresh?: boolean } = {}): Promise<SearchResult<Character>> {
    return filterCharacters(await this.all(opts), q);
  }

  async byIds(): Promise<Map<number, Character>> {
    if (!this.byId) await this.all();
    return this.byId!;
  }

  /** Full detail (drop chance per pack, market prices) from the server. */
  detail(id: number): Promise<CharacterDetail> {
    return this.api.catalog.character(id);
  }

  async seriesSummary(): Promise<Array<{ series: string; count: number; byRarity: Partial<Record<Rarity, number>> }>> {
    const map = new Map<string, { count: number; byRarity: Partial<Record<Rarity, number>> }>();
    for (const c of await this.all()) {
      const e = map.get(c.series) ?? { count: 0, byRarity: {} };
      e.count++;
      e.byRarity[c.rarity] = (e.byRarity[c.rarity] ?? 0) + 1;
      map.set(c.series, e);
    }
    return [...map].map(([series, v]) => ({ series, ...v })).sort((a, b) => b.count - a.count);
  }

  private remember(items: Character[]): Character[] {
    this.memory = items;
    this.byId = new Map(items.map((c) => [c.id, c]));
    return items;
  }
}
