import type { Logger } from '../utils/logger.js';
import { AuthRequiredError } from '../utils/errors.js';
import { sleep } from '../utils/time.js';

export interface PollOptions {
  intervalMs: number;
  /** Hard floor so a misconfiguration cannot hammer the site. */
  minIntervalMs: number;
  /** The loop stops by itself after this long. */
  maxDurationMs: number;
  maxTicks?: number;
  signal?: AbortSignal;
  log: Logger;
  sleepFn?: (ms: number, signal?: AbortSignal) => Promise<void>;
  random?: () => number;
}

const MAX_BACKOFF_MS = 15 * 60_000;

/**
 * Bounded polling loop: a floor on the interval, jitter, exponential backoff on errors, a
 * maximum duration and abort support. An AuthRequiredError ends the loop by propagating.
 *
 * The task may return a delay hint (ms) to wake earlier than the interval, e.g. when an
 * auction enters its bidding window. Hints are clamped to [minIntervalMs, interval] and
 * ignored after a failed tick.
 */
export async function poll(task: (tick: number) => Promise<number | void>, o: PollOptions): Promise<{ ticks: number; reason: string }> {
  const interval = Math.max(o.intervalMs, o.minIntervalMs);
  const wait = o.sleepFn ?? sleep;
  const rnd = o.random ?? Math.random;
  const deadline = Date.now() + o.maxDurationMs;
  let failures = 0;
  let tick = 0;
  let hint: number | undefined;
  while (!o.signal?.aborted) {
    if (Date.now() >= deadline) return { ticks: tick, reason: 'max duration reached' };
    if (o.maxTicks !== undefined && tick >= o.maxTicks) return { ticks: tick, reason: 'max ticks reached' };
    try {
      const h = await task(tick);
      hint = typeof h === 'number' && Number.isFinite(h) ? h : undefined;
      failures = 0;
    } catch (err) {
      if (err instanceof AuthRequiredError) throw err;
      failures++;
      hint = undefined;
      o.log.warn(`Poll tick failed (${failures} in a row): ${(err as Error).message}`);
    }
    tick++;
    if (o.maxTicks !== undefined && tick >= o.maxTicks) return { ticks: tick, reason: 'max ticks reached' };
    const base = failures ? Math.min(MAX_BACKOFF_MS, interval * 2 ** failures) : interval;
    const delay = hint !== undefined && !failures ? Math.min(interval, Math.max(o.minIntervalMs, Math.round(hint))) : Math.round(base * (0.9 + rnd() * 0.2));
    try {
      await wait(delay, o.signal);
    } catch {
      break; // aborted
    }
  }
  return { ticks: tick, reason: 'stopped' };
}
