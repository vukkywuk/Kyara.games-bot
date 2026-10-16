import { useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { Layers, PlugZap } from 'lucide-react';
import { CharacterDrawer } from '../components/CharacterDrawer';
import { EmptyState, ErrorState, Meter, PageHeader, Panel, Segmented, Skeleton, inputClass } from '../components/ui';
import { explain } from '../lib/api';
import { num } from '../lib/format';
import { useCharacters, useCollection, useStatus } from '../lib/queries';
import { RARITY, RARITY_ORDER } from '../lib/rarity';
import type { Character } from '../lib/types';
import { VirtualGrid } from './Explorer';
import { normalize } from '../../../src/modules/characterSearch';

type Sort = 'recent' | 'rarity' | 'qty' | 'name';

export function CollectionPage() {
  const status = useStatus();
  const loggedIn = !!status.data?.session.hasToken;
  const col = useCollection(loggedIn);
  const chars = useCharacters();
  const [params, setParams] = useSearchParams();
  const sort = (['recent', 'rarity', 'qty', 'name'].includes(params.get('sort') ?? '') ? params.get('sort') : 'recent') as Sort;
  const [q, setQ] = useState('');
  const open = Number(params.get('c')) || null;

  const owned = useMemo(() => new Map((col.data?.entries ?? []).filter((e) => e.qty > 0).map((e) => [e.characterId, e])), [col.data]);
  const qtyMap = useMemo(() => new Map([...owned].map(([id, e]) => [id, e.qty])), [owned]);
  // in your own collection every card is owned: only extra copies are worth a badge
  const dupBadges = useMemo(() => new Map([...qtyMap].filter(([, q]) => q > 1)), [qtyMap]);
  const items = useMemo(() => {
    const byId = new Map((chars.data ?? []).map((c) => [c.id, c]));
    const n = normalize(q);
    const list = [...owned.values()].map((e) => ({ e, c: byId.get(e.characterId) })).filter((x): x is { e: (typeof x)['e']; c: Character } => !!x.c && (!n || normalize(`${x.c.name} ${x.c.native ?? ''} ${x.c.series}`).includes(n)));
    list.sort((a, b) =>
      sort === 'recent'
        ? (b.e.firstAt ?? '').localeCompare(a.e.firstAt ?? '')
        : sort === 'rarity'
          ? RARITY[b.c.rarity].rank - RARITY[a.c.rarity].rank || a.c.rank - b.c.rank
          : sort === 'qty'
            ? b.e.qty - a.e.qty
            : a.c.name.localeCompare(b.c.name),
    );
    return list.map((x) => x.c);
  }, [owned, chars.data, q, sort]);

  if (status.data && !loggedIn)
    return (
      <>
        <PageHeader title="My collection" />
        <EmptyState icon={PlugZap} title="Connect your account to see your collection" action={<Link to="/session" className="text-focus underline underline-offset-4">Set up the session</Link>} />
      </>
    );

  const stats = col.data?.stats;
  return (
    <>
      <PageHeader title="My collection" description={stats ? `${num(stats.unique)} characters, ${num(stats.copies)} cards, ${stats.completionPct}% of the catalogue.` : 'Your cards on Kyara.'} />
      {col.isError && <ErrorState message={explain(col.error)} onRetry={() => void col.refetch()} />}

      <div className="mb-5 grid gap-4 lg:grid-cols-[minmax(0,1fr)_340px]">
        <Panel title="Completion by rarity">
          {!stats ? (
            <Skeleton className="h-32" />
          ) : (
            <ul className="grid gap-x-8 gap-y-2.5 sm:grid-cols-2">
              {RARITY_ORDER.map((r) => (
                <li key={r} className="grid grid-cols-[84px_1fr_74px] items-center gap-3 text-sm">
                  <span className="text-washi-dim">{RARITY[r].name}</span>
                  <Meter value={stats.byRarity[r].owned} max={stats.byRarity[r].total} color={RARITY[r].color} label={`${RARITY[r].name} completion`} />
                  <span className="num text-right text-muted">
                    {stats.byRarity[r].owned}/{stats.byRarity[r].total}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Panel>
        <Panel title="Duplicates">
          {!stats ? (
            <Skeleton className="h-20" />
          ) : (
            <>
              <p className="num font-display text-2xl font-bold">{num(stats.duplicates)}</p>
              <p className="text-sm text-muted">
                {stats.duplicates === 0
                  ? 'Every card you own is unique.'
                  : stats.duplicateRecycleValue !== null
                    ? `Worth about ${num(stats.duplicateRecycleValue)} chakra if recycled on Kyara.`
                    : 'Extra copies of characters you own.'}
              </p>
            </>
          )}
        </Panel>
      </div>

      {stats && stats.topSeries.length > 0 && (
        <Panel title="Closest series to completion" className="mb-5">
          <ul className="grid gap-x-8 gap-y-2 md:grid-cols-2">
            {stats.topSeries.slice(0, 6).map((s) => (
              <li key={s.series} className="grid grid-cols-[minmax(0,1fr)_120px_70px] items-center gap-3 text-sm">
                <Link to={`/characters?series=${encodeURIComponent(s.series)}`} className="truncate text-washi-dim hover:text-washi hover:underline">
                  {s.series}
                </Link>
                <Meter value={s.owned} max={s.total} label={`${s.series} completion`} />
                <span className="num text-right text-muted">
                  {s.owned}/{s.total}
                </span>
              </li>
            ))}
          </ul>
        </Panel>
      )}

      <div className="z-20 -mx-4 mb-4 flex md:sticky md:top-0 flex-wrap items-center gap-3 border-b border-line bg-ink-0/92 px-4 py-3 backdrop-blur sm:-mx-6 sm:px-6">
        <label htmlFor="col-q" className="sr-only">
          Filter your collection
        </label>
        <input id="col-q" type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter by name or series" className={`${inputClass} max-w-[320px]`} />
        <Segmented<Sort>
          label="Sort"
          layoutId="col-sort"
          value={sort}
          onChange={(v) => setParams((p) => (v === 'recent' ? p.delete('sort') : p.set('sort', v), p), { replace: true, preventScrollReset: true })}
          options={[
            { value: 'recent', label: 'Newest' },
            { value: 'rarity', label: 'Rarity' },
            { value: 'qty', label: 'Copies' },
            { value: 'name', label: 'Name' },
          ]}
        />
        <p className="num ml-auto text-sm text-muted">{num(items.length)} shown</p>
      </div>

      {!col.data || !chars.data ? (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(148px,1fr))] gap-4">
          {Array.from({ length: 12 }, (_, i) => (
            <Skeleton key={i} className="aspect-[2/3]" />
          ))}
        </div>
      ) : items.length === 0 ? (
        <EmptyState icon={Layers} title={owned.size ? 'Nothing matches this filter' : 'Your collection is empty'} action={!owned.size ? <Link to="/packs" className="text-focus underline">Open a pack</Link> : undefined} />
      ) : (
        <VirtualGrid items={items} owned={dupBadges} onOpen={(c) => setParams((p) => (p.set('c', String(c.id)), p), { preventScrollReset: true })} selectedId={open} />
      )}

      <CharacterDrawer id={open} owned={open ? qtyMap.get(open) : undefined} fallback={chars.data?.find((c) => c.id === open)} onClose={() => setParams((p) => (p.delete('c'), p), { replace: true, preventScrollReset: true })} />
    </>
  );
}
