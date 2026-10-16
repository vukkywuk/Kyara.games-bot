import { motion } from 'motion/react';
import { Link } from 'react-router';
import { Gavel, X } from 'lucide-react';
import { explain } from '../lib/api';
import { num, dateTime } from '../lib/format';
import { useCharacter, usePacks, usePrices } from '../lib/queries';
import { RARITY } from '../lib/rarity';
import type { Character } from '../lib/types';
import { CharacterArt, RaritySeal } from './character';
import { Drawer } from './overlay';
import { ErrorState, IconButton, Skeleton } from './ui';

export function CharacterDrawer({ id, owned, fallback, onClose }: { id: number | null; owned?: number; fallback?: Character; onClose: () => void }) {
  return (
    <Drawer open={id !== null} onClose={onClose} width={560} labelledBy="char-drawer-title">
      {id !== null && <Detail id={id} owned={owned} fallback={fallback} onClose={onClose} />}
    </Drawer>
  );
}

function Detail({ id, owned, fallback, onClose }: { id: number; owned?: number; fallback?: Character; onClose: () => void }) {
  const detail = useCharacter(id);
  const prices = usePrices(id);
  const packs = usePacks();
  const c = detail.data ?? fallback;
  if (!c) return <div className="p-5">{detail.isError ? <ErrorState message={explain(detail.error)} /> : <Skeleton className="h-64" />}</div>;
  const r = RARITY[c.rarity];
  const packName = new Map((packs.data?.packs ?? []).map((p) => [p.pack.id, p.pack.name]));
  const drops = Object.entries(detail.data?.dropChance ?? {})
    .filter(([, v]) => v > 0)
    .sort((a, b) => b[1] - a[1]);
  const maxDrop = drops[0]?.[1] ?? 0;
  const p = prices.data ?? detail.data?.prices;

  return (
    <div className="relative">
      <div className="absolute right-3 top-3 z-10">
        <IconButton icon={X} label="Close" onClick={onClose} className="bg-ink-0/70 backdrop-blur" />
      </div>
      <div className="grid gap-5 p-5 sm:grid-cols-[200px_1fr]">
        <motion.div
          initial={{ opacity: 0, scale: 0.96 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={{ duration: 0.28, ease: [0.2, 0.8, 0.2, 1] }}
          className="relative mx-auto w-[200px]"
        >
          <CharacterArt character={c} eager sizes="200px" />
          <span aria-hidden className="absolute inset-x-0 bottom-0 h-[3px]" style={{ background: r.color }} />
        </motion.div>
        <div className="min-w-0">
          <div className="flex items-start gap-3 pr-10">
            <RaritySeal rarity={c.rarity} size={34} className="mt-1" />
            <div className="min-w-0">
              <h2 id="char-drawer-title" className="font-display text-xl font-bold leading-tight">
                {c.name}
              </h2>
              {c.native && <p className="mt-1 text-md text-washi-dim">{c.native}</p>}
            </div>
          </div>
          <p className="mt-3 text-muted">
            {r.name} from <span className="text-washi">{c.series}</span>
          </p>
          <p className="num mt-1 text-sm text-faint">{catalogueLine(c.num)}</p>
          <dl aria-label="Statistics" className="mt-4 grid grid-cols-2 gap-px overflow-hidden rounded-[var(--radius-ctl)] bg-line">
            {[
              ['Power', c.pow],
              ['Aura', c.aura],
              ['Favourites', c.favourites],
              ['You own', owned ?? 0],
            ].map(([k, v]) => (
              <div key={k as string} className="bg-ink-2 px-3 py-2.5">
                <dt className="text-xs text-muted">{k}</dt>
                <dd className="num mt-0.5 font-display text-md font-bold">{typeof v === 'number' ? num(v) : v}</dd>
              </div>
            ))}
          </dl>
        </div>
      </div>

      <section className="border-t border-line px-5 py-4" aria-labelledby="mk-h">
        <div className="flex items-center justify-between">
          <h3 id="mk-h" className="font-bold">
            Market
          </h3>
          <Link to={`/market?characterId=${c.id}`} className="inline-flex items-center gap-1.5 text-sm text-focus underline-offset-4 hover:underline">
            <Gavel size={14} aria-hidden /> Listings for {c.name.split(' ')[0]}
          </Link>
        </div>
        {!p ? (
          <Skeleton className="mt-3 h-14" />
        ) : p.sales30d === 0 ? (
          <p className="mt-2 text-sm text-muted">No sale in the last 30 days.</p>
        ) : (
          <dl className="mt-3 grid grid-cols-3 gap-4">
            <div>
              <dt className="text-xs text-muted">Median, 7 days</dt>
              <dd className="num font-display text-lg font-bold">{num(p.median7d)}</dd>
              <dd className="text-xs text-faint">{p.sales7d} sales</dd>
            </div>
            <div>
              <dt className="text-xs text-muted">Median, 30 days</dt>
              <dd className="num font-display text-lg font-bold">{num(p.median30d)}</dd>
              <dd className="text-xs text-faint">{p.sales30d} sales</dd>
            </div>
            <div>
              <dt className="text-xs text-muted">Last sale</dt>
              <dd className="num font-display text-lg font-bold">{num(p.lastPrice)}</dd>
              {p.lastAt && <dd className="text-xs text-faint">{dateTime(p.lastAt)}</dd>}
            </div>
          </dl>
        )}
      </section>

      <section className="border-t border-line px-5 py-4" aria-labelledby="drop-h">
        <h3 id="drop-h" className="font-bold">
          Drop chance per booster
        </h3>
        {detail.isLoading ? (
          <Skeleton className="mt-3 h-24" />
        ) : drops.length === 0 ? (
          <p className="mt-2 text-sm text-muted">Not in any pack right now{c.rarity === 'M' ? ' (Mythics can come from the Mythic seal reward pack)' : ''}.</p>
        ) : (
          <ul className="mt-3 flex flex-col gap-2">
            {drops.map(([pack, pct]) => (
              <li key={pack} className="grid grid-cols-[minmax(0,1fr)_120px_64px] items-center gap-3 text-sm">
                <span className="truncate text-washi-dim">{packName.get(pack) ?? pack}</span>
                <span className="h-1.5 overflow-hidden rounded-full bg-ink-3" aria-hidden>
                  <span className="block h-full rounded-full" style={{ width: `${(pct / maxDrop) * 100}%`, background: r.color }} />
                </span>
                <span className="num text-right">{formatPct(pct)}%</span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

/** "#0001/6736" -> "No. 1 of 6,736 by popularity". */
function catalogueLine(numStr: string): string {
  const m = /#?0*(\d+)\/(\d+)/.exec(numStr);
  return m ? `No. ${Number(m[1]).toLocaleString('en-US')} of ${Number(m[2]).toLocaleString('en-US')} by popularity` : numStr;
}

/** Tiny chances keep two significant digits instead of rounding to 0. */
export function formatPct(p: number): string {
  if (p === 0) return '0';
  if (p >= 0.01) return p.toFixed(p >= 1 ? 1 : 3);
  return Number(p.toPrecision(2)).toString();
}
