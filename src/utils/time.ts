export const sleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(t);
      reject(signal?.reason);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });

/** "3 h 05 min", "2 j 4 h" style durations, but in English. */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms)) return '?';
  const sign = ms < 0 ? '-' : '';
  const totalSec = Math.floor(Math.abs(ms) / 1000);
  const d = Math.floor(totalSec / 86400);
  const h = Math.floor((totalSec % 86400) / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (d > 0) return `${sign}${d}d ${h}h`;
  if (h > 0) return `${sign}${h}h ${String(m).padStart(2, '0')}m`;
  if (m > 0) return `${sign}${m}m ${String(s).padStart(2, '0')}s`;
  return `${sign}${s}s`;
}

/** Tracks the offset between server time (Date header) and local time, like the site does. */
export class ServerClock {
  private offsetMs = 0;
  observe(dateHeader: string | null): void {
    const t = dateHeader ? Date.parse(dateHeader) : NaN;
    if (Number.isNaN(t)) return;
    const offset = t - Date.now();
    if (Math.abs(offset - this.offsetMs) > 1500) this.offsetMs = offset;
  }
  now(): number {
    return Date.now() + this.offsetMs;
  }
}
