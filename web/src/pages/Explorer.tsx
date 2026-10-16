import { useVirtualizer } from '@tanstack/react-virtual';
import { AnimatePresence, motion } from 'motion/react';
import { useCallback, useDeferredValue, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router';
import { ArrowDownWideNarrow, ArrowUpNarrowWide, RotateCcw, SearchX } from 'lucide-react';
import { filterCharacters } from '../../../src/modules/characterSearch';
import type { CharacterQuery, CharacterSort } from '../../../src/modules/characterSearch';
import { CharacterCard, RaritySeal } from '../components/character';
import { CharacterDrawer } from '../components/CharacterDrawer';
import { useMainScroll } from '../components/Shell';
import { Button, Chip, EmptyState, ErrorState, IconButton, PageHeader, Segmented, Skeleton, cx, inputClass } from '../components/ui';
import { explain } from '../lib/api';
import { num } from '../lib/format';
import { useCharacters, useCollection, useStatus } from '../lib/queries';
import { RARITY, RARITY_ORDER } from '../lib/rarity';
import type { Character, Rarity } from '../lib/types';

const SORTS: Array<{ value: CharacterSort; label: string }> = [
  { value: 'rank', label: 'Popularity rank' },
  { value: 'rarity', label: 'Rarity' },
  { value: 'pow', label: 'Power' },
  { value: 'aura', label: 'Aura' },
  { value: 'favourites', label: 'Favourites' },
  { value: 'name', label: 'Name' },
];

type Ownership = 'all' | 'owned' | 'missing';

/** Filter state lives in the URL: shareable, survives navigation, back/forward works. */
function useExplorerState() {
  const [params, setParams] = useSearchParams();
  const get = (k: string) => params.get(k) ?? '';
  const state = {
    q: get('q'),
    rarities: (get('rarity') ? get('rarity').split(',') : []).filter((r): r is Rarity => r in RARITY),
    series: get('series'),
    minPow: get('minPow'),
    minAura: get('minAura'),
    sort: (SORTS.some((s) => s.value === get('sort')) ? get('sort') : 'rank') as CharacterSort,
    order: (get('order') === 'asc' || get('order') === 'desc' ? get('order') : '') as '' | 'asc' | 'desc',
    own: (['owned', 'missing'].includes(get('own')) ? get('own') : 'all') as Ownership,
    open: Number(get('c')) || null,
  };
  const set = useCallback(
    (patch: Record<string, string | null>, opts: { push?: boolean } = {}) =>
      setParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          for (const [k, v] of Object.entries(patch)) {
            if (v === null || v === '' || (k === 'sort' && v === 'rank') || (k === 'own' && v === 'all')) next.delete(k);
            else next.set(k, v);
          }
          return next;
        },
        { replace: !opts.push, preventScrollReset: true },
      ),
    [setParams],
  );
  return { state, set };
}

export function Explorer() {
  const chars = useCharacters();
  const status = useStatus();
  const loggedIn = !!status.data?.session.hasToken;
  const collection = useCollection(loggedIn);
  const { state, set } = useExplorerState();
  const [text, setText] = useState(state.q);
  const deferredText = useDeferredValue(text);

  // keep the box in sync when the URL changes from outside (top-bar search, back button)
  const [urlQ, setUrlQ] = useState(state.q);
  if (state.q !== urlQ) {
    setUrlQ(state.q);
    setText(state.q);
  }
  useEffect(() => {
    const t = setTimeout(() => {
      if (text !== state.q) set({ q: text || null });
    }, 250);
    return () => clearTimeout(t);
  }, [text, state.q, set]);

  const ownedMap = useMemo(() => new Map((collection.data?.entries ?? []).filter((e) => e.qty > 0).map((e) => [e.characterId, e.qty])), [collection.data]);

  const series = useMemo(() => {
    const s = new Map<string, number>();
    for (const c of chars.data ?? []) s.set(c.series, (s.get(c.series) ?? 0) + 1);
    return [...s.entries()].sort((a, b) => b[1] - a[1]).map(([name]) => name);
  }, [chars.data]);

  const result = useMemo(() => {
    const all = chars.data ?? [];
    const trimmed = deferredText.trim();
    const ids = /^\d+$/.test(trimmed) ? [Number(trimmed)] : undefined;
    const q: CharacterQuery = {
      text: ids ? undefined : trimmed || undefined,
      ids,
      rarities: state.rarities.length ? state.rarities : undefined,
      series: state.series || undefined,
      minPow: state.minPow ? Number(state.minPow) : undefined,
      minAura: state.minAura ? Number(state.minAura) : undefined,
      sort: state.sort,
      order: state.order || undefined,
      limit: 100_000,
    };
    let items = filterCharacters(all, q).items;
    if (loggedIn && state.own !== 'all') items = items.filter((c) => (state.own === 'owned') === ownedMap.has(c.id));
    return items;
  }, [chars.data, deferredText, state.rarities, state.series, state.minPow, state.minAura, state.sort, state.order, state.own, loggedIn, ownedMap]);

  const chips: Array<{ key: string; label: React.ReactNode; clear: Record<string, null> }> = [];
  if (state.q) chips.push({ key: 'q', label: `“${state.q}”`, clear: { q: null } });
  for (const r of state.rarities)
    chips.push({
      key: `r-${r}`,
      label: (
        <span className="inline-flex items-center gap-1.5">
          <span aria-hidden className="h-2 w-2 rounded-full" style={{ background: RARITY[r].color }} />
          {RARITY[r].name}
        </span>
      ),
      clear: { rarity: null },
    });
  if (state.series) chips.push({ key: 'series', label: state.series, clear: { series: null } });
  if (state.minPow) chips.push({ key: 'pow', label: `Power ≥ ${state.minPow}`, clear: { minPow: null } });
  if (state.minAura) chips.push({ key: 'aura', label: `Aura ≥ ${state.minAura}`, clear: { minAura: null } });
  if (state.own !== 'all') chips.push({ key: 'own', label: state.own === 'owned' ? 'Owned' : 'Missing', clear: { own: null } } as never);

  const toggleRarity = (r: Rarity) => {
    const next = state.rarities.includes(r) ? state.rarities.filter((x) => x !== r) : [...state.rarities, r];
    set({ rarity: next.length ? next.join(',') : null });
  };

  const openChar = useCallback((c: Character) => set({ c: String(c.id) }, { push: true }), [set]);
  const filterKey = [state.rarities.join(), state.series, state.minPow, state.minAura, state.sort, state.order, state.own].join('|');

  return (
    <>
      <PageHeader
        title="Characters"
        description={chars.data ? `All ${num(chars.data.length)} characters in Kyara's current catalogue. Search by name, native name or ID.` : 'The full Kyara catalogue.'}
      />

      <div className="z-20 -mx-4 mb-4 border-b md:sticky md:top-0 border-line bg-ink-0/92 px-4 pb-3 pt-1 backdrop-blur sm:-mx-6 sm:px-6">
        <div className="flex flex-wrap items-end gap-3">
          <div className="min-w-[220px] flex-[2_1_260px]">
            <label htmlFor="ex-q" className="mb-1.5 block text-sm text-washi-dim">
              Name or ID
            </label>
            <input id="ex-q" type="search" value={text} onChange={(e) => setText(e.target.value)} placeholder="Gojo, 五条, 127691" className={inputClass} autoComplete="off" />
          </div>
          <div className="min-w-[180px] flex-[1_1_200px]">
            <label htmlFor="ex-series" className="mb-1.5 block text-sm text-washi-dim">
              Series
            </label>
            <input id="ex-series" list="ex-series-list" value={state.series} onChange={(e) => set({ series: e.target.value || null })} placeholder="Any series" className={inputClass} />
            <datalist id="ex-series-list">
              {series.slice(0, 400).map((s) => (
                <option key={s} value={s} />
              ))}
            </datalist>
          </div>
          <div className="w-[104px]">
            <label htmlFor="ex-pow" className="mb-1.5 block text-sm text-washi-dim">
              Min power
            </label>
            <input id="ex-pow" inputMode="numeric" value={state.minPow} onChange={(e) => set({ minPow: e.target.value.replace(/\D/g, '').slice(0, 3) || null })} placeholder="0" className={cx(inputClass, 'num')} />
          </div>
          <div className="w-[104px]">
            <label htmlFor="ex-aura" className="mb-1.5 block text-sm text-washi-dim">
              Min aura
            </label>
            <input id="ex-aura" inputMode="numeric" value={state.minAura} onChange={(e) => set({ minAura: e.target.value.replace(/\D/g, '').slice(0, 3) || null })} placeholder="0" className={cx(inputClass, 'num')} />
          </div>
          <div className="flex items-end gap-1">
            <div className="w-[170px]">
              <label htmlFor="ex-sort" className="mb-1.5 block text-sm text-washi-dim">
                Sort by
              </label>
              <select id="ex-sort" value={state.sort} onChange={(e) => set({ sort: e.target.value, order: null })} className={inputClass}>
                {SORTS.map((s) => (
                  <option key={s.value} value={s.value}>
                    {s.label}
                  </option>
                ))}
              </select>
            </div>
            <IconButton
              icon={state.order === 'asc' ? ArrowUpNarrowWide : ArrowDownWideNarrow}
              label={state.order === 'asc' ? 'Ascending order (switch to descending)' : 'Default order (switch to ascending)'}
              onClick={() => set({ order: state.order === 'asc' ? null : 'asc' })}
              size={40}
              className="border border-line"
            />
          </div>
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-2">
          <div role="group" aria-label="Rarity" className="flex gap-1">
            {RARITY_ORDER.map((r) => {
              const on = state.rarities.includes(r);
              return (
                <button
                  key={r}
                  type="button"
                  aria-pressed={on}
                  aria-label={RARITY[r].name}
                  onClick={() => toggleRarity(r)}
                  className={cx('flex h-8 items-center gap-1.5 rounded-[var(--radius-ctl)] border px-2 text-sm transition-colors duration-150', on ? 'border-line-strong bg-ink-3 text-washi' : 'border-transparent text-washi-dim hover:bg-ink-2')}
                >
                  <RaritySeal rarity={r} size={18} decorative />
                  <span aria-hidden className="hidden lg:inline">
                    {RARITY[r].name}
                  </span>
                </button>
              );
            })}
          </div>
          {loggedIn && (
            <div className="ml-auto">
              <Segmented<Ownership>
                label="Ownership"
                layoutId="ex-own"
                value={state.own}
                onChange={(v) => set({ own: v })}
                options={[
                  { value: 'all', label: 'All' },
                  { value: 'owned', label: 'Owned', count: ownedMap.size },
                  { value: 'missing', label: 'Missing' },
                ]}
              />
            </div>
          )}
        </div>

        <div className="mt-3 flex min-h-7 flex-wrap items-center gap-2">
          <p className="num mr-1 text-sm text-muted" aria-live="polite">
            {chars.data ? `${num(result.length)} of ${num(chars.data.length)}` : 'Loading…'}
          </p>
          <AnimatePresence initial={false}>
            {chips.map((c) => (
              <Chip key={c.key} onRemove={() => set(c.clear)} removeLabel={`Remove filter ${typeof c.label === 'string' ? c.label : c.key}`}>
                {c.label}
              </Chip>
            ))}
          </AnimatePresence>
          {chips.length > 0 && (
            <Button
              size="sm"
              variant="ghost"
              icon={RotateCcw}
              onClick={() => {
                setText('');
                set({ q: null, rarity: null, series: null, minPow: null, minAura: null, own: null, sort: null, order: null });
              }}
            >
              Reset filters
            </Button>
          )}
        </div>
      </div>

      {chars.isError ? (
        <ErrorState message={explain(chars.error)} onRetry={() => void chars.refetch()} />
      ) : !chars.data ? (
        <GridSkeleton />
      ) : result.length === 0 ? (
        <EmptyState icon={SearchX} title="No character matches these filters" action={<Button onClick={() => (setText(''), set({ q: null, rarity: null, series: null, minPow: null, minAura: null, own: null }))}>Reset filters</Button>}>
          Try a shorter name, another series, or fewer rarities.
        </EmptyState>
      ) : (
        <motion.div key={filterKey} initial={{ opacity: 0.35 }} animate={{ opacity: 1 }} transition={{ duration: 0.18 }}>
          <VirtualGrid items={result} owned={ownedMap} onOpen={openChar} selectedId={state.open} />
        </motion.div>
      )}

      <CharacterDrawer
        id={state.open}
        owned={state.open ? ownedMap.get(state.open) : undefined}
        fallback={chars.data?.find((c) => c.id === state.open)}
        onClose={() => set({ c: null })}
      />
    </>
  );
}

const MIN_CARD = 148;
const GAP = 16;

function useColumns(ref: React.RefObject<HTMLDivElement | null>) {
  const [w, setW] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setW(e!.contentRect.width));
    ro.observe(el);
    setW(el.getBoundingClientRect().width);
    return () => ro.disconnect();
  }, [ref]);
  const cols = Math.max(2, Math.floor((w + GAP) / (MIN_CARD + GAP)));
  const cardW = w > 0 ? (w - GAP * (cols - 1)) / cols : MIN_CARD;
  return { cols, cardW, width: w };
}

/** Only the rows in view are rendered; the rest is empty space with the right height. */
export function VirtualGrid({ items, owned, onOpen, selectedId }: { items: Character[]; owned?: Map<number, number>; onOpen: (c: Character) => void; selectedId?: number | null }) {
  const scrollRef = useMainScroll();
  const gridRef = useRef<HTMLDivElement>(null);
  const { cols, cardW, width } = useColumns(gridRef);
  const rowH = Math.round(cardW * 1.5 + 48 + GAP);
  const rows = Math.ceil(items.length / cols);
  const [offset, setOffset] = useState(0);
  useLayoutEffect(() => {
    const grid = gridRef.current;
    const scroller = scrollRef.current;
    if (grid && scroller) setOffset(grid.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop);
  }, [scrollRef, width, items.length]);

  // TanStack Virtual returns mutable state, so the React Compiler skips this component; that is expected.
  // eslint-disable-next-line react-hooks/incompatible-library
  const v = useVirtualizer({
    count: rows,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => rowH,
    overscan: 3,
    scrollMargin: offset,
  });
  useEffect(() => v.measure(), [rowH, v]);

  return (
    <div ref={gridRef} role="list" aria-label="Characters" style={{ height: v.getTotalSize(), position: 'relative' }}>
      {width > 0 &&
        v.getVirtualItems().map((row) => (
          <div
            key={row.key}
            className="absolute left-0 top-0 grid w-full"
            style={{ transform: `translateY(${row.start - v.options.scrollMargin}px)`, gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`, gap: GAP, height: rowH - GAP }}
          >
            {items.slice(row.index * cols, row.index * cols + cols).map((c) => (
              <div role="listitem" key={c.id}>
                <CharacterCard character={c} owned={owned?.get(c.id)} onOpen={onOpen} selected={selectedId === c.id} />
              </div>
            ))}
          </div>
        ))}
    </div>
  );
}

function GridSkeleton() {
  return (
    <div className="grid grid-cols-[repeat(auto-fill,minmax(148px,1fr))] gap-4" aria-label="Loading characters" role="status">
      {Array.from({ length: 18 }, (_, i) => (
        <div key={i}>
          <Skeleton className="aspect-[2/3] w-full" />
          <Skeleton className="mt-2 h-3.5 w-3/4" />
          <Skeleton className="mt-1.5 h-3 w-1/2" />
        </div>
      ))}
    </div>
  );
}
