const nf = new Intl.NumberFormat('en-US');

export const num = (n: number | null | undefined): string => (n === null || n === undefined || Number.isNaN(n) ? '–' : nf.format(n));

/** "2d 4h", "3h 05m", "4m 09s", "12s". */
export function duration(ms: number): string {
  if (!Number.isFinite(ms)) return '–';
  const s = Math.max(0, Math.floor(ms / 1000));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${String(m).padStart(2, '0')}m`;
  if (m > 0) return `${m}m ${String(sec).padStart(2, '0')}s`;
  return `${sec}s`;
}

export function ago(iso: string | number | null | undefined, now = Date.now()): string {
  if (iso === null || iso === undefined) return 'never';
  const t = typeof iso === 'number' ? iso : Date.parse(iso);
  if (!Number.isFinite(t)) return '–';
  const s = Math.round((now - t) / 1000);
  if (s < 5) return 'just now';
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return `${Math.floor(s / 86400)} d ago`;
}

/** "+50 chakra, +1 bonus pack, +1 seal-mythic" */
export function describeGain(g: { chakra?: number; bonusPacks?: number; grants: Record<string, number> }): string {
  const parts = [g.chakra ? `+${num(g.chakra)} chakra` : '', g.bonusPacks ? `+${g.bonusPacks} bonus pack${g.bonusPacks > 1 ? 's' : ''}` : '', ...Object.entries(g.grants).map(([k, n]) => `+${n} ${k}`)].filter(Boolean);
  return parts.join(', ') || 'Done';
}

export function clock(iso: string): string {
  return new Date(iso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

export function dateTime(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}
