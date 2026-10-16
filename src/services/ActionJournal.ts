import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { redact } from '../utils/redact.js';

export type ActionStatus = 'pending' | 'succeeded' | 'failed' | 'unknown';

export interface ActionRecord {
  id: string;
  kind: string;
  /** Intent key used for duplicate detection, e.g. `bid:<listing>:<amount>`. */
  key: string;
  summary: string;
  cost: number;
  params: Record<string, unknown>;
  status: ActionStatus;
  startedAt: string;
  finishedAt: string | null;
  /** Idempotency key sent to the server, when the endpoint supports one. */
  requestId: string | null;
  result: Record<string, unknown> | null;
  error: string | null;
  resolvedBy?: 'user' | null;
}

/**
 * Append-only JSONL log of every state-changing action. The latest line for an id
 * wins. It survives crashes, so an action interrupted mid-flight shows up as
 * `pending`/`unknown` on the next run instead of being silently retried.
 */
export class ActionJournal {
  private records = new Map<string, ActionRecord>();
  private loaded = false;

  constructor(private readonly file: string | null) {}

  private load(): void {
    if (this.loaded) return;
    this.loaded = true;
    if (!this.file || !fs.existsSync(this.file)) return;
    for (const line of fs.readFileSync(this.file, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        const r = JSON.parse(line) as ActionRecord;
        if (r && typeof r.id === 'string') this.records.set(r.id, r);
      } catch {
        /* skip a torn last line */
      }
    }
  }

  private append(r: ActionRecord): void {
    this.records.set(r.id, r);
    if (!this.file) return;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.appendFileSync(this.file, JSON.stringify(redact(r)) + '\n', { mode: 0o600 });
  }

  begin(input: Pick<ActionRecord, 'kind' | 'key' | 'summary' | 'cost' | 'params' | 'requestId'> & { id?: string }): ActionRecord {
    this.load();
    const rec: ActionRecord = {
      id: input.id ?? randomUUID(),
      kind: input.kind,
      key: input.key,
      summary: input.summary,
      cost: input.cost,
      params: input.params,
      requestId: input.requestId,
      status: 'pending',
      startedAt: new Date().toISOString(),
      finishedAt: null,
      result: null,
      error: null,
    };
    this.append(rec);
    return rec;
  }

  finish(id: string, status: Exclude<ActionStatus, 'pending'>, data: { result?: Record<string, unknown>; error?: string; resolvedBy?: 'user' }): ActionRecord {
    this.load();
    const prev = this.records.get(id);
    if (!prev) throw new Error(`Unknown action ${id}`);
    const rec: ActionRecord = {
      ...prev,
      status,
      finishedAt: new Date().toISOString(),
      result: data.result ?? prev.result,
      error: data.error ?? null,
      resolvedBy: data.resolvedBy ?? prev.resolvedBy ?? null,
    };
    this.append(rec);
    return rec;
  }

  get(id: string): ActionRecord | undefined {
    this.load();
    return this.records.get(id) ?? [...this.records.values()].find((r) => r.id.startsWith(id));
  }

  list(filter: { status?: ActionStatus; limit?: number } = {}): ActionRecord[] {
    this.load();
    const all = [...this.records.values()]
      .filter((r) => !filter.status || r.status === filter.status)
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
    return filter.limit ? all.slice(0, filter.limit) : all;
  }

  /** Unresolved actions (in flight in a crashed process, or ambiguous) with the same intent key. */
  unresolved(key: string): ActionRecord[] {
    this.load();
    return [...this.records.values()].filter((r) => r.key === key && (r.status === 'pending' || r.status === 'unknown'));
  }

  lastSucceeded(key: string): ActionRecord | undefined {
    this.load();
    return [...this.records.values()]
      .filter((r) => r.key === key && r.status === 'succeeded')
      .sort((a, b) => (b.finishedAt ?? '').localeCompare(a.finishedAt ?? ''))[0];
  }

  /** Sum of chakra committed by succeeded/unknown actions of a kind since a time (for budgets). */
  spentSince(kindPrefix: string, sinceMs: number): number {
    this.load();
    return [...this.records.values()]
      .filter((r) => r.kind.startsWith(kindPrefix) && (r.status === 'succeeded' || r.status === 'unknown'))
      .filter((r) => Date.parse(r.startedAt) >= sinceMs)
      .reduce((s, r) => s + r.cost, 0);
  }
}
