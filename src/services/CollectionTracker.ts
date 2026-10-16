import fs from 'node:fs';
import path from 'node:path';
import type { CollectionEntry } from '../api/schemas/account.js';

export interface CollectionSnapshot {
  takenAt: string;
  entries: Array<{ characterId: number; qty: number }>;
}

export interface CollectionDiff {
  from: string;
  to: string;
  added: Array<{ characterId: number; qty: number }>;
  removed: Array<{ characterId: number; qty: number }>;
  changed: Array<{ characterId: number; before: number; after: number }>;
}

export function diffCollections(a: CollectionSnapshot, b: CollectionSnapshot): CollectionDiff {
  const before = new Map(a.entries.map((e) => [e.characterId, e.qty]));
  const after = new Map(b.entries.map((e) => [e.characterId, e.qty]));
  const out: CollectionDiff = { from: a.takenAt, to: b.takenAt, added: [], removed: [], changed: [] };
  for (const [id, qty] of after) {
    const prev = before.get(id) ?? 0;
    if (prev === 0 && qty > 0) out.added.push({ characterId: id, qty });
    else if (prev !== qty) out.changed.push({ characterId: id, before: prev, after: qty });
  }
  for (const [id, qty] of before) if (qty > 0 && (after.get(id) ?? 0) === 0) out.removed.push({ characterId: id, qty });
  return out;
}

/** Stores collection snapshots on disk so changes can be diffed between runs. */
export class CollectionTracker {
  constructor(private readonly dir: string) {}

  snapshotOf(entries: CollectionEntry[], at = new Date()): CollectionSnapshot {
    return {
      takenAt: at.toISOString(),
      entries: entries.filter((e) => e.qty > 0).map((e) => ({ characterId: e.characterId, qty: e.qty })),
    };
  }

  save(s: CollectionSnapshot): string {
    fs.mkdirSync(this.dir, { recursive: true });
    const file = path.join(this.dir, `collection-${s.takenAt.replace(/[:.]/g, '-')}.json`);
    fs.writeFileSync(file, JSON.stringify(s));
    return file;
  }

  list(): string[] {
    if (!fs.existsSync(this.dir)) return [];
    return fs
      .readdirSync(this.dir)
      .filter((f) => f.startsWith('collection-') && f.endsWith('.json'))
      .sort()
      .map((f) => path.join(this.dir, f));
  }

  latest(): CollectionSnapshot | null {
    const files = this.list();
    const last = files.at(-1);
    return last ? (JSON.parse(fs.readFileSync(last, 'utf8')) as CollectionSnapshot) : null;
  }
}
