import type { KyaraApi } from '../api/KyaraApi.js';
import type { CollectionEntry } from '../api/schemas/account.js';
import type { Character, Rarity } from '../api/schemas/common.js';
import { RARITIES } from '../api/schemas/common.js';
import type { CharacterModule } from './CharacterModule.js';
import { normalize } from './CharacterModule.js';

export interface OwnedCard {
  character: Character | null;
  characterId: number;
  qty: number;
  listable: number | null;
  firstAt: string | null;
}

export interface CollectionStats {
  unique: number;
  copies: number;
  catalogSize: number;
  completionPct: number;
  duplicates: number;
  /** Chakra obtainable by recycling every duplicate (per /api/config recycle values). */
  duplicateRecycleValue: number | null;
  byRarity: Record<Rarity, { owned: number; total: number }>;
  topSeries: Array<{ series: string; owned: number; total: number; pct: number }>;
}

export interface CollectionFilter {
  rarities?: Rarity[];
  series?: string;
  text?: string;
  duplicatesOnly?: boolean;
}

export class CollectionModule {
  constructor(
    private readonly api: KyaraApi,
    private readonly characters: CharacterModule,
  ) {}

  raw(): Promise<CollectionEntry[]> {
    return this.api.account.collection();
  }

  async owned(filter: CollectionFilter = {}, entries?: CollectionEntry[]): Promise<OwnedCard[]> {
    const [list, byId] = await Promise.all([entries ? Promise.resolve(entries) : this.raw(), this.characters.byIds()]);
    return joinCollection(list, byId, filter);
  }

  async missing(filter: Omit<CollectionFilter, 'duplicatesOnly'> = {}, entries?: CollectionEntry[]): Promise<Character[]> {
    const [list, all] = await Promise.all([entries ? Promise.resolve(entries) : this.raw(), this.characters.all()]);
    const have = new Set(list.filter((e) => e.qty > 0).map((e) => e.characterId));
    const series = filter.series ? normalize(filter.series) : null;
    const rar = filter.rarities?.length ? new Set(filter.rarities) : null;
    return all.filter(
      (c) => !have.has(c.id) && (!rar || rar.has(c.rarity)) && (!series || normalize(c.series).includes(series)),
    );
  }

  async stats(entries?: CollectionEntry[], recycle?: Record<string, number>): Promise<CollectionStats> {
    const [list, all] = await Promise.all([entries ? Promise.resolve(entries) : this.raw(), this.characters.all()]);
    const recycleValues = recycle ?? (await this.api.catalog.config()).recycle;
    return computeStats(list, all, recycleValues);
  }
}

export function joinCollection(list: CollectionEntry[], byId: Map<number, Character>, filter: CollectionFilter = {}): OwnedCard[] {
  const series = filter.series ? normalize(filter.series) : null;
  const text = filter.text ? normalize(filter.text) : null;
  const rar = filter.rarities?.length ? new Set(filter.rarities) : null;
  return list
    .filter((e) => e.qty > 0)
    .map((e) => ({
      character: byId.get(e.characterId) ?? null,
      characterId: e.characterId,
      qty: e.qty,
      listable: e.listable ?? null,
      firstAt: e.firstAt ?? null,
    }))
    .filter((o) => {
      if (filter.duplicatesOnly && o.qty < 2) return false;
      const c = o.character;
      if (!c) return !rar && !series && !text;
      if (rar && !rar.has(c.rarity)) return false;
      if (series && !normalize(c.series).includes(series)) return false;
      if (text && !normalize(`${c.name} ${c.native ?? ''}`).includes(text)) return false;
      return true;
    })
    .sort((a, b) => (a.character?.rank ?? 1e9) - (b.character?.rank ?? 1e9));
}

export function computeStats(list: CollectionEntry[], all: Character[], recycle: Record<string, number>): CollectionStats {
  const byId = new Map(all.map((c) => [c.id, c]));
  const owned = list.filter((e) => e.qty > 0);
  const byRarity = Object.fromEntries(RARITIES.map((r) => [r, { owned: 0, total: 0 }])) as CollectionStats['byRarity'];
  for (const c of all) byRarity[c.rarity].total++;
  const seriesTotals = new Map<string, number>();
  for (const c of all) seriesTotals.set(c.series, (seriesTotals.get(c.series) ?? 0) + 1);
  const seriesOwned = new Map<string, number>();

  let copies = 0;
  let duplicates = 0;
  let recycleValue = 0;
  let recycleKnown = true;
  for (const e of owned) {
    copies += e.qty;
    const c = byId.get(e.characterId);
    if (!c) continue;
    byRarity[c.rarity].owned++;
    seriesOwned.set(c.series, (seriesOwned.get(c.series) ?? 0) + 1);
    const dupes = Math.max(0, e.qty - 1);
    duplicates += dupes;
    const v = recycle[c.rarity];
    if (v === undefined) recycleKnown = false;
    else recycleValue += dupes * v;
  }
  const topSeries = [...seriesOwned]
    .map(([series, n]) => {
      const total = seriesTotals.get(series) ?? n;
      return { series, owned: n, total, pct: Math.round((n / total) * 1000) / 10 };
    })
    // Kyara's own mission counts series of 5 or more characters, so those rank first.
    .sort((a, b) => Number(b.total >= 5) - Number(a.total >= 5) || b.pct - a.pct || b.total - a.total)
    .slice(0, 10);
  return {
    unique: owned.length,
    copies,
    catalogSize: all.length,
    completionPct: all.length ? Math.round((owned.length / all.length) * 1000) / 10 : 0,
    duplicates,
    duplicateRecycleValue: recycleKnown ? recycleValue : null,
    byRarity,
    topSeries,
  };
}
