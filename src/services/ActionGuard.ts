import fs from 'node:fs';
import path from 'node:path';
import { TransportFailure } from '../api/transport.js';
import {
  ActionRefusedError,
  AmbiguousOutcomeError,
  AuthRequiredError,
  KyaraApiError,
  KyaraError,
  NetworkError,
  RateLimitedError,
  SchemaMismatchError,
} from '../utils/errors.js';
import type { Logger } from '../utils/logger.js';
import type { ActionJournal, ActionRecord } from './ActionJournal.js';

export interface ActionSpec<T> {
  kind: string;
  /** Intent key for duplicate detection. Same key = same intended effect. */
  key: string;
  /** One-line, human-readable description shown before confirmation. */
  summary: string;
  /** Maximum chakra this action can spend (0 when it spends nothing). */
  cost: number;
  params: Record<string, unknown>;
  /** Idempotency key sent to the server, if the endpoint supports one. */
  requestId?: string | null;
  /** Synchronous input validation. Throw ActionRefusedError('invalid_input'). */
  validate?: () => void;
  /** Server-side prerequisite checks (balance, availability). Throw ActionRefusedError. */
  preflight?: () => Promise<void>;
  /** Whether an explicit "yes" is needed (spending, irreversible). */
  confirm: boolean;
  /** After a success with the same key, refuse a repeat within this window (ms). */
  repeatCooldownMs?: number;
  execute: () => Promise<T>;
  summarize: (result: T) => Record<string, unknown>;
}

export interface GuardOptions {
  /** Prompt shown to the user. Return true to proceed. */
  confirm?: (summary: string) => Promise<boolean>;
  /** Skip the prompt (the user passed --yes). */
  assumeYes?: boolean;
  dryRun?: boolean;
  /** Allow cost above maxSpendPerAction. */
  forceBudget?: boolean;
  /**
   * Re-send an action recorded as `unknown`. Only allowed when it has a server
   * idempotency key, so the server can deduplicate.
   */
  resume?: ActionRecord;
}

export type GuardOutcome<T> =
  | { status: 'dry-run'; summary: string; cost: number }
  | { status: 'succeeded'; action: ActionRecord; result: T };

const LOCK_STALE_MS = 5 * 60_000;
const GATE_CODES = new Set(['catalog_loading', 'starting', 'maintenance']);

/**
 * The single path through which state-changing operations run.
 *   validate → budget → duplicate/unknown check → preflight → budget → confirm → lock → execute → record
 * Mutations are sent once. A failure where the server may have applied the change is
 * recorded as `unknown` and surfaced as AmbiguousOutcomeError; it is never retried blindly.
 */
export class ActionGuard {
  private inFlight = new Set<string>();

  constructor(
    private readonly journal: ActionJournal,
    private readonly log: Logger,
    /** A number, or a getter for limits that can change at runtime (in-app settings). */
    private readonly maxSpend: number | (() => number),
    private readonly lockFile: string | null,
  ) {}

  private get maxSpendPerAction(): number {
    return typeof this.maxSpend === 'function' ? this.maxSpend() : this.maxSpend;
  }

  async run<T>(spec: ActionSpec<T>, opts: GuardOptions = {}): Promise<GuardOutcome<T>> {
    spec.validate?.();
    this.checkBudget(spec.cost, opts);
    // Reserved for the whole flow, including preflight and the confirmation prompt.
    if (this.inFlight.has(spec.key)) throw new ActionRefusedError('The same action is already running.', 'duplicate');
    this.inFlight.add(spec.key);
    try {
      this.checkHistory(spec, opts);

      await spec.preflight?.();
      // The real cost is often only known after preflight (quotes, current prices).
      this.checkBudget(spec.cost, opts);

      if (opts.dryRun) return { status: 'dry-run', summary: spec.summary, cost: spec.cost };

      if (spec.confirm && !opts.assumeYes) {
        const ok = opts.confirm ? await opts.confirm(spec.summary) : false;
        if (!ok) throw new ActionRefusedError('Not confirmed; nothing was sent.', 'not_confirmed');
      }

      const releaseLock = this.acquireLock();
      try {
        return await this.execute(spec, opts.resume);
      } finally {
        releaseLock();
      }
    } finally {
      this.inFlight.delete(spec.key);
    }
  }

  private checkHistory<T>(spec: ActionSpec<T>, opts: GuardOptions): void {
    if (opts.resume) {
      if (opts.resume.key !== spec.key) throw new ActionRefusedError('The action to resume does not match this command.', 'invalid_input');
      if (!opts.resume.requestId) {
        throw new ActionRefusedError(
          'This action has no server idempotency key, so re-sending it could apply it twice. Check the account and resolve it with `kyara actions resolve`.',
          'pending_unknown',
        );
      }
      return;
    }
    const unresolved = this.journal.unresolved(spec.key);
    if (unresolved.length) {
      const ids = unresolved.map((r) => r.id.slice(0, 8)).join(', ');
      const resumable = unresolved.some((r) => r.requestId) ? ' or resume it with --resume <id>' : '';
      throw new ActionRefusedError(
        `A previous identical action (${ids}) has an unknown outcome. Check your account, then run \`kyara actions resolve <id> --as succeeded|failed\`${resumable}.`,
        'pending_unknown',
      );
    }
    if (spec.repeatCooldownMs) {
      const last = this.journal.lastSucceeded(spec.key);
      const ago = last?.finishedAt ? Date.now() - Date.parse(last.finishedAt) : Infinity;
      if (last && ago < spec.repeatCooldownMs) {
        throw new ActionRefusedError(
          `The same action succeeded ${Math.round(ago / 1000)}s ago (${last.id.slice(0, 8)}). Refusing a duplicate.`,
          'duplicate',
        );
      }
    }
  }

  private async execute<T>(spec: ActionSpec<T>, resume: ActionRecord | undefined): Promise<GuardOutcome<T>> {
    const rec =
      resume ??
      this.journal.begin({
        kind: spec.kind,
        key: spec.key,
        summary: spec.summary,
        cost: spec.cost,
        params: spec.params,
        requestId: spec.requestId ?? null,
      });
    this.log.info(`Executing: ${spec.summary}`, { action: rec.id.slice(0, 8) });
    let result: T;
    try {
      result = await spec.execute();
    } catch (err) {
      const ambiguous = isAmbiguous(err);
      // A failed re-send says nothing about the ORIGINAL attempt: a resumed action stays unknown.
      this.journal.finish(rec.id, ambiguous || resume ? 'unknown' : 'failed', { error: (err as Error).message });
      if (ambiguous) {
        throw new AmbiguousOutcomeError(
          `Outcome unknown for "${spec.summary}" (${(err as Error).message}). It was NOT retried. Check your account before doing anything else; action id ${rec.id.slice(0, 8)}.`,
          rec.id,
          { cause: err },
        );
      }
      throw err;
    }
    const done = this.journal.finish(rec.id, 'succeeded', { result: spec.summarize(result) });
    return { status: 'succeeded', action: done, result };
  }

  private checkBudget(cost: number, opts: GuardOptions): void {
    if (cost > this.maxSpendPerAction && !opts.forceBudget) {
      throw new ActionRefusedError(
        `This action may spend ${cost} chakra, above the per-action limit of ${this.maxSpendPerAction} (Settings, or KYARA_MAX_SPEND_PER_ACTION). Pass --force-budget to allow it.`,
        'over_budget',
      );
    }
  }

  /** Cross-process mutex so two CLI processes never send mutations concurrently. */
  private acquireLock(): () => void {
    if (!this.lockFile) return () => undefined;
    const file = this.lockFile;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        fs.writeFileSync(file, JSON.stringify({ pid: process.pid, at: Date.now() }), { flag: 'wx' });
        return () => fs.rmSync(file, { force: true });
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
        if (attempt === 0 && this.isStale(file)) {
          this.log.warn('Removing a stale action lock left by a crashed process.');
          fs.rmSync(file, { force: true });
          continue;
        }
        throw new ActionRefusedError('Another kyara process is performing an action right now.', 'duplicate');
      }
    }
    throw new KyaraError('Could not acquire the action lock.');
  }

  private isStale(file: string): boolean {
    try {
      const { pid, at } = JSON.parse(fs.readFileSync(file, 'utf8')) as { pid: number; at: number };
      if (Date.now() - at > LOCK_STALE_MS) return true;
      try {
        process.kill(pid, 0);
        return false;
      } catch {
        return true;
      }
    } catch {
      return true;
    }
  }
}

/**
 * Could the server have applied the change? True for timeouts, dropped connections,
 * 5xx answers, and 2xx answers we failed to parse. False for definite refusals.
 */
export function isAmbiguous(err: unknown): boolean {
  if (err instanceof SchemaMismatchError) return true;
  if (err instanceof NetworkError) {
    const cause = err.cause;
    return !(cause instanceof TransportFailure && cause.notSent);
  }
  // 503 gate codes are returned before the request is processed (server starting / maintenance).
  if (err instanceof KyaraApiError) return err.status >= 500 && !GATE_CODES.has(err.code);
  if (err instanceof RateLimitedError || err instanceof AuthRequiredError) return false;
  if (err instanceof KyaraError) return false;
  return true;
}
