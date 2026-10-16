import type { Rarity } from '../api/schemas/common.js';
import { RARITIES } from '../api/schemas/common.js';
import { UsageError } from '../utils/errors.js';

export interface Column<T> {
  header: string;
  get: (row: T) => string | number | null | undefined;
  align?: 'left' | 'right';
  max?: number;
}

const width = (s: string): number => {
  // East Asian wide characters take two columns in most terminals.
  let w = 0;
  for (const ch of s) w += /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦]/.test(ch) ? 2 : 1;
  return w;
};

function clip(s: string, max: number): string {
  if (width(s) <= max) return s;
  let out = '';
  for (const ch of s) {
    if (width(out + ch) > max - 1) break;
    out += ch;
  }
  return out + '…';
}

export function table<T>(rows: T[], cols: Column<T>[]): string {
  const cells = rows.map((r) => cols.map((c) => clip(String(c.get(r) ?? ''), c.max ?? 40)));
  const widths = cols.map((c, i) => Math.max(width(c.header), ...cells.map((row) => width(row[i] ?? ''))));
  const pad = (s: string, i: number): string => {
    const gap = ' '.repeat(Math.max(0, (widths[i] ?? 0) - width(s)));
    return cols[i]?.align === 'right' ? gap + s : s + gap;
  };
  const lines = [cols.map((c, i) => pad(c.header, i)).join('  '), widths.map((w) => '─'.repeat(w)).join('  ')];
  for (const row of cells) lines.push(row.map((s, i) => pad(s, i)).join('  ').trimEnd());
  return lines.join('\n');
}

export function print(s: string): void {
  process.stdout.write(s + '\n');
}

export function printJson(v: unknown): void {
  process.stdout.write(JSON.stringify(v, null, 2) + '\n');
}

export function parseRarities(v: string | undefined): Rarity[] | undefined {
  if (!v) return undefined;
  const parts = v
    .toUpperCase()
    .split(/[,\s]+/)
    .filter(Boolean);
  for (const p of parts) if (!RARITIES.includes(p as Rarity)) throw new UsageError(`Unknown rarity "${p}". Use: ${RARITIES.join(', ')}`);
  return parts as Rarity[];
}

export function parseIntArg(name: string, min = 0, max = Number.MAX_SAFE_INTEGER) {
  return (v: string): number => {
    const n = Number(v);
    if (!Number.isInteger(n) || n < min || n > max) throw new UsageError(`${name} must be an integer between ${min} and ${max}, got "${v}"`);
    return n;
  };
}

/** "90s", "5m", "2h", "1d" or plain milliseconds. */
export function parseDuration(v: string): number {
  const m = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)?$/i.exec(v.trim());
  if (!m) throw new UsageError(`Invalid duration "${v}" (examples: 30s, 5m, 2h)`);
  const n = Number(m[1]);
  const unit = (m[2] ?? 'ms').toLowerCase();
  const mult = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[unit] ?? 1;
  return Math.round(n * mult);
}

export const fmtNum = (n: number | null | undefined): string => (n === null || n === undefined || Number.isNaN(n) ? '–' : n.toLocaleString('en-US'));
