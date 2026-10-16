import { useQuery } from '@tanstack/react-query';
import { AnimatePresence, motion } from 'motion/react';
import { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { ChevronLeft, ChevronRight, Gavel, Lock, SearchX, ShoppingCart } from 'lucide-react';
import { CharacterArt, RaritySeal } from '../components/character';
import { Drawer, useToast } from '../components/overlay';
import { Button, EmptyState, ErrorState, Field, IconButton, PageHeader, Panel, Segmented, Skeleton, StatusDot, cx, inputClass } from '../components/ui';
import { useConfirmFlow } from '../components/useConfirmFlow';
import { api, explain, get } from '../lib/api';
import { ago, dateTime, duration, num } from '../lib/format';
import { useActions, useListing, useListings, useNow, usePrices, useStatus } from '../lib/queries';
import { RARITY, RARITY_ORDER } from '../lib/rarity';
import type { ActionResponse, Listing, Rarity } from '../lib/types';

const PAGE_SIZE = 25;
type Tab = 'listings' | 'activity';

export function MarketPage() {
  const [params, setParams] = useSearchParams();
  const status = useStatus();
  const loggedIn = !!status.data?.session.hasToken;
  const tab = (params.get('tab') === 'activity' ? 'activity' : 'listings') as Tab;
  const set = (patch: Record<string, string | null>) =>
    setParams(
      (prev) => {
        const n = new URLSearchParams(prev);
        for (const [k, v] of Object.entries(patch)) {
          if (v) n.set(k, v);
          else n.delete(k);
        }
        return n;
      },
      { replace: true, preventScrollReset: true },
    );

  return (
    <>
      <PageHeader
        title="Market"
        description="Live listings from Kyara. Bids are maximums: Kyara reserves the amount and refunds it if you are outbid."
        actions={
          <Segmented<Tab>
            label="Market view"
            layoutId="mk-tab"
            value={tab}
            onChange={(v) => set({ tab: v === 'listings' ? null : v })}
            options={[
              { value: 'listings', label: 'Listings' },
              { value: 'activity', label: 'Your activity' },
            ]}
          />
        }
      />
      {loggedIn && <AccessBanner />}
      <AnimatePresence mode="wait" initial={false}>
        <motion.div key={tab} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -4 }} transition={{ duration: 0.18 }}>
          {tab === 'listings' ? <Listings params={params} set={set} loggedIn={loggedIn} /> : <MarketActivity loggedIn={loggedIn} />}
        </motion.div>
      </AnimatePresence>
      <ListingDrawer id={params.get('l')} onClose={() => set({ l: null })} loggedIn={loggedIn} />
    </>
  );
}

function AccessBanner() {
  const access = useQuery({ queryKey: ['market-access'], queryFn: () => get<{ allowed: boolean; reasons: string[] }>('/market/access'), staleTime: 5 * 60_000 });
  if (!access.data || access.data.allowed) return null;
  return (
    <div role="status" className="mb-4 flex items-start gap-3 rounded-[var(--radius-panel)] border border-warn/30 bg-warn/5 p-4">
      <Lock size={18} className="mt-0.5 text-warn" aria-hidden />
      <div>
        <p className="font-bold">The market is not open to your account yet</p>
        <p className="text-sm text-muted">{access.data.reasons.join(' ') || 'Kyara gates the market by account age and activity.'} You can still browse.</p>
      </div>
    </div>
  );
}

function Listings({ params, set, loggedIn }: { params: URLSearchParams; set: (p: Record<string, string | null>) => void; loggedIn: boolean }) {
  const now = useNow(1000);
  const urlQ = params.get('q') ?? '';
  const [text, setText] = useState(urlQ);
  const [seenQ, setSeenQ] = useState(urlQ);
  if (urlQ !== seenQ) {
    setSeenQ(urlQ);
    setText(urlQ);
  }
  useEffect(() => {
    const t = setTimeout(() => text !== (params.get('q') ?? '') && set({ q: text || null, page: null }), 300);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text]);

  const type = params.get('type') ?? '';
  const query = useMemo(
    () => ({
      q: params.get('q') ?? '',
      rarity: params.get('rarity') ?? '',
      type,
      sort: params.get('sort') ?? 'ending',
      characterId: params.get('characterId') ?? '',
      page: params.get('page') ?? '1',
      pageSize: String(PAGE_SIZE),
    }),
    [params, type],
  );
  const listings = useListings(query, { live: true });
  const maxPrice = Number(params.get('max') ?? '') || null;
  const items = (listings.data?.items ?? []).filter((l) => maxPrice === null || (l.currentBid ?? l.price) <= maxPrice);
  const page = Number(query.page);
  const pages = listings.data ? Math.max(1, Math.ceil(listings.data.total / PAGE_SIZE)) : 1;

  return (
    <>
      <div className="mb-4 flex flex-wrap items-end gap-3">
        <div className="min-w-[200px] flex-[2_1_240px]">
          <label htmlFor="mk-q" className="mb-1.5 block text-sm text-washi-dim">
            Character
          </label>
          <input id="mk-q" type="search" value={text} onChange={(e) => setText(e.target.value)} placeholder="Name" className={inputClass} />
        </div>
        <div className="w-[150px]">
          <label htmlFor="mk-r" className="mb-1.5 block text-sm text-washi-dim">
            Rarity
          </label>
          <select id="mk-r" value={query.rarity} onChange={(e) => set({ rarity: e.target.value || null, page: null })} className={inputClass}>
            <option value="">Any</option>
            {RARITY_ORDER.map((r) => (
              <option key={r} value={r}>
                {RARITY[r].name}
              </option>
            ))}
          </select>
        </div>
        <div className="w-[170px]">
          <label htmlFor="mk-s" className="mb-1.5 block text-sm text-washi-dim">
            Sort
          </label>
          <select id="mk-s" value={query.sort} onChange={(e) => set({ sort: e.target.value === 'ending' ? null : e.target.value, page: null })} className={inputClass}>
            <option value="ending">Ending soonest</option>
            <option value="newest">Newest</option>
            <option value="price_asc">Price, low to high</option>
            <option value="price_desc">Price, high to low</option>
          </select>
        </div>
        <div className="w-[130px]">
          <label htmlFor="mk-max" className="mb-1.5 block text-sm text-washi-dim">
            Max price
          </label>
          <input id="mk-max" inputMode="numeric" value={params.get('max') ?? ''} onChange={(e) => set({ max: e.target.value.replace(/\D/g, '') || null })} placeholder="Any" className={cx(inputClass, 'num')} />
        </div>
        <Segmented
          label="Listing type"
          layoutId="mk-type"
          value={type || 'all'}
          onChange={(v) => set({ type: v === 'all' ? null : v, page: null })}
          options={[
            { value: 'all', label: 'All' },
            { value: 'auction', label: 'Auctions' },
            { value: 'fixed', label: 'Fixed price' },
          ]}
        />
      </div>
      {query.characterId && (
        <p className="mb-3 text-sm text-muted">
          Showing one character.{' '}
          <button type="button" className="text-focus underline underline-offset-4" onClick={() => set({ characterId: null, page: null })}>
            Show all
          </button>
        </p>
      )}

      <Panel bodyClass="p-0">
        {listings.isError ? (
          <div className="p-4">
            <ErrorState message={explain(listings.error)} onRetry={() => void listings.refetch()} />
          </div>
        ) : !listings.data ? (
          <div className="space-y-px p-2">
            {Array.from({ length: 10 }, (_, i) => (
              <Skeleton key={i} className="h-14" />
            ))}
          </div>
        ) : items.length === 0 ? (
          <EmptyState icon={SearchX} title="No listing matches">
            Change the filters or come back later. New listings appear all the time.
          </EmptyState>
        ) : (
          <>
          <ul className="divide-y divide-line md:hidden" aria-label="Market listings">
            {items.map((l) => {
              const left = Date.parse(l.endsAt) - now;
              return (
                <li key={l.id}>
                  <button type="button" onClick={() => set({ l: l.id })} className={cx('grid w-full grid-cols-[40px_minmax(0,1fr)_auto] items-center gap-3 px-4 py-2.5 text-left hover:bg-ink-2', left <= 0 && 'opacity-45')}>
                    <div className="w-10">
                      <CharacterArt character={l.character} sizes="40px" />
                    </div>
                    <div className="min-w-0">
                      <p className="flex items-center gap-1.5 truncate text-sm font-bold">
                        <RaritySeal rarity={l.character.rarity} size={15} />
                        <span className="truncate">{l.character.name}</span>
                      </p>
                      <p className="truncate text-xs text-muted">{l.type === 'auction' ? `Auction, ${l.bidCount} bid${l.bidCount === 1 ? '' : 's'}` : 'Fixed price'}</p>
                    </div>
                    <div className="text-right">
                      <p className="num font-display font-bold">{num(l.currentBid ?? l.price)}</p>
                      <p className={cx('num text-xs', l.type === 'auction' && left > 0 && left < 5 * 60_000 ? 'font-bold text-warn' : 'text-muted')}>{left > 0 ? duration(left) : 'Closing'}</p>
                    </div>
                  </button>
                </li>
              );
            })}
          </ul>
          <div className="hidden overflow-x-auto md:block">
            <table className="w-full min-w-[820px] border-collapse text-sm">
              <caption className="sr-only">Market listings</caption>
              <thead>
                <tr className="border-b border-line text-left text-xs text-muted">
                  <th scope="col" className="py-2.5 pl-4 pr-3 font-normal">Character</th>
                  <th scope="col" className="px-3 font-normal">Type</th>
                  <th scope="col" className="px-3 text-right font-normal">Price</th>
                  <th scope="col" className="px-3 text-right font-normal">Next bid</th>
                  <th scope="col" className="px-3 text-right font-normal">Buy now</th>
                  <th scope="col" className="px-3 text-right font-normal">Bids</th>
                  <th scope="col" className="px-3 text-right font-normal">Median 7d</th>
                  <th scope="col" className="py-2.5 pl-3 pr-4 text-right font-normal">Ends in</th>
                </tr>
              </thead>
              <tbody className={cx('transition-opacity duration-150', listings.isPlaceholderData && 'opacity-60')}>
                {items.map((l) => (
                  <ListingRow key={l.id} l={l} now={now} onOpen={() => set({ l: l.id })} loggedIn={loggedIn} />
                ))}
              </tbody>
            </table>
          </div>
          </>
        )}
      </Panel>

      {listings.data && listings.data.total > PAGE_SIZE && (
        <nav aria-label="Pages" className="mt-4 flex items-center justify-end gap-2 text-sm">
          <span className="num text-muted">
            Page {page} of {num(pages)} ({num(listings.data.total)} listings)
          </span>
          <IconButton icon={ChevronLeft} label="Previous page" disabled={page <= 1} onClick={() => set({ page: page - 1 > 1 ? String(page - 1) : null })} className="border border-line disabled:opacity-40" />
          <IconButton icon={ChevronRight} label="Next page" disabled={page >= pages} onClick={() => set({ page: String(page + 1) })} className="border border-line disabled:opacity-40" />
        </nav>
      )}
    </>
  );
}

function ListingRow({ l, now, onOpen, loggedIn }: { l: Listing; now: number; onOpen: () => void; loggedIn: boolean }) {
  const left = Date.parse(l.endsAt) - now;
  const soon = l.type === 'auction' && left > 0 && left < 5 * 60_000;
  const closing = left <= 0;
  const buyNow = l.type === 'fixed' ? l.price : l.buyoutPrice;
  return (
    <tr className={cx('cursor-pointer border-b border-line/70 transition-[background-color,opacity] duration-200 last:border-0 hover:bg-ink-2', closing && 'opacity-45')} onClick={onOpen}>
      <td className="py-2 pl-4 pr-3">
        <div className="flex items-center gap-3">
          <div className="w-9 shrink-0">
            <CharacterArt character={l.character} sizes="36px" />
          </div>
          <div className="min-w-0">
            <button type="button" onClick={onOpen} className="flex max-w-[34ch] items-center gap-2 truncate text-left font-bold hover:underline">
              <RaritySeal rarity={l.character.rarity} size={16} />
              <span className="truncate">{l.character.name}</span>
            </button>
            <p className="max-w-[40ch] truncate text-xs text-muted">{l.character.series}</p>
          </div>
          {loggedIn && (l.isMine || l.leading !== null || l.myMaxBid) && (
            <span className={cx('ml-auto shrink-0 rounded-[var(--radius-chip)] px-1.5 py-0.5 text-xs', l.isMine ? 'bg-ink-3 text-washi-dim' : l.leading ? 'bg-ok/15 text-ok' : 'bg-warn/15 text-warn')}>
              {l.isMine ? 'Yours' : l.leading ? 'Leading' : 'Outbid'}
            </span>
          )}
        </div>
      </td>
      <td className="px-3 text-washi-dim">{l.type === 'auction' ? 'Auction' : 'Fixed'}</td>
      <td className="num px-3 text-right font-display font-bold">{num(l.currentBid ?? l.price)}</td>
      <td className="num px-3 text-right text-washi-dim">{l.type === 'auction' ? num(l.minNextBid) : '–'}</td>
      <td className="num px-3 text-right text-washi-dim">{num(buyNow)}</td>
      <td className="num px-3 text-right text-washi-dim">{l.type === 'auction' ? l.bidCount : '–'}</td>
      <td className="num px-3 text-right text-faint">{num(l.prices?.median7d)}</td>
      <td className={cx('num py-2 pl-3 pr-4 text-right', soon ? 'font-bold text-warn' : 'text-washi-dim')} title={closing ? 'Ended; Kyara is settling it' : undefined}>
        {closing ? 'Closing' : duration(left)}
      </td>
    </tr>
  );
}

function ListingDrawer({ id, onClose, loggedIn }: { id: string | null; onClose: () => void; loggedIn: boolean }) {
  return (
    <Drawer open={!!id} onClose={onClose} title="Listing" width={520}>
      {id && <ListingDetail id={id} loggedIn={loggedIn} onClose={onClose} />}
    </Drawer>
  );
}

function ListingDetail({ id, loggedIn, onClose }: { id: string; loggedIn: boolean; onClose: () => void }) {
  const listing = useListing(id);
  const l = listing.data;
  const prices = usePrices(l?.character.id ?? null);
  const now = useNow(1000);
  const toast = useToast();
  // null until the user types: until then the field shows the current minimum next bid
  const [typed, setAmount] = useState<string | null>(null);

  const bid = useConfirmFlow<{ id: string; maxAmount: number }, { leading: boolean; currentBid: number | null; chakra: number }>({
    run: (v) => api<ActionResponse<{ leading: boolean; currentBid: number | null; chakra: number }>>(`/market/listings/${v.id}/bid`, { method: 'POST', body: { maxAmount: v.maxAmount, [v.mode]: true } }),
    title: 'Place this bid?',
    confirmLabel: 'Place bid',
    onSuccess: (r) => {
      void listing.refetch();
      toast(r.leading ? { kind: 'success', title: `You lead at ${num(r.currentBid)}`, detail: `Chakra now ${num(r.chakra)}.` } : { kind: 'warn', title: 'Someone has a higher maximum', detail: 'Nothing was taken. Bid more to take the lead.' });
    },
  });
  const buy = useConfirmFlow<{ id: string }, { chakra: number }>({
    run: (v) => api<ActionResponse<{ chakra: number }>>(`/market/listings/${v.id}/buy`, { method: 'POST', body: { [v.mode]: true } }),
    title: 'Buy this card?',
    confirmLabel: 'Buy',
    onSuccess: (r) => {
      toast({ kind: 'success', title: `${l?.character.name ?? 'Card'} is yours`, detail: `Chakra now ${num(r.chakra)}.` });
      onClose();
    },
  });

  if (listing.isError) return <div className="p-5"><ErrorState message={explain(listing.error)} onRetry={() => void listing.refetch()} /></div>;
  if (!l) return <div className="p-5"><Skeleton className="h-72" /></div>;
  const left = Date.parse(l.endsAt) - now;
  const buyNow = l.type === 'fixed' ? l.price : l.buyoutPrice;
  const p = prices.data;
  const amount = typed ?? (l.minNextBid ? String(l.minNextBid) : '');
  const amountNum = Number(amount);
  const amountError = !amount ? null : !Number.isInteger(amountNum) || amountNum <= 0 ? 'Enter a whole number' : l.minNextBid !== null && amountNum < l.minNextBid ? `At least ${num(l.minNextBid)}` : buyNow !== null && amountNum >= buyNow ? 'At or above the buy-now price: buy instead' : null;
  const ended = l.status !== 'active' || left <= 0;

  return (
    <div className="p-5">
      <div className="grid grid-cols-[140px_1fr] gap-5">
        <div className="relative">
          <CharacterArt character={l.character} eager sizes="140px" />
          <span aria-hidden className="absolute inset-x-0 bottom-0 h-[3px]" style={{ background: RARITY[l.character.rarity as Rarity].color }} />
        </div>
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <RaritySeal rarity={l.character.rarity} size={24} />
            <h3 className="truncate font-display text-lg font-bold">{l.character.name}</h3>
          </div>
          <p className="mt-1 truncate text-sm text-muted">{l.character.series}</p>
          <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-3 text-sm">
            <div>
              <dt className="text-xs text-muted">{l.type === 'auction' ? 'Current bid' : 'Price'}</dt>
              <dd className="num font-display text-xl font-bold">{num(l.currentBid ?? l.price)}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted">Ends</dt>
              <dd className={cx('num font-display text-xl font-bold', !ended && left < 5 * 60_000 && 'text-warn')}>{ended ? (l.status === 'active' ? 'Closing' : 'Ended') : duration(left)}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted">Seller</dt>
              <dd>{l.isMine ? 'You' : l.seller.pseudo}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted">Bids</dt>
              <dd className="num">{l.type === 'auction' ? l.bidCount : 'Fixed price'}</dd>
            </div>
          </dl>
          {loggedIn && l.myMaxBid !== null && (
            <p className="mt-3 flex items-center gap-2 text-sm">
              <StatusDot tone={l.leading ? 'ok' : 'warn'} />
              Your maximum: <span className="num font-bold">{num(l.myMaxBid)}</span>, {l.leading ? 'leading' : 'outbid'}
            </p>
          )}
        </div>
      </div>

      <section className="mt-6 border-t border-line pt-4" aria-label="Price history">
        <h3 className="font-bold">Recent sales of this character</h3>
        {!p ? (
          <Skeleton className="mt-3 h-12" />
        ) : p.lastSales.length === 0 ? (
          <p className="mt-2 text-sm text-muted">No recorded sale. Median 30 days: {num(p.median30d)}.</p>
        ) : (
          <>
            <p className="num mt-1 text-sm text-muted">
              Median 7 days {num(p.median7d)}, 30 days {num(p.median30d)}
            </p>
            <ul className="mt-2 flex flex-wrap gap-2">
              {p.lastSales.slice(0, 12).map((s, i) => (
                <li key={i} className="num rounded-[var(--radius-chip)] bg-ink-2 px-2 py-1 text-sm" title={s.at ? dateTime(s.at) : undefined}>
                  {num(s.price)}
                </li>
              ))}
            </ul>
          </>
        )}
        <p className="mt-2 text-xs text-faint">Kyara does not publish the bid history of a listing; only its current state.</p>
      </section>

      {!ended && !l.isMine && (
        <section className="mt-6 border-t border-line pt-4" aria-label="Actions">
          {!loggedIn ? (
            <p className="text-sm text-muted">
              <Link to="/session" className="text-focus underline underline-offset-4">Connect your account</Link> to bid or buy.
            </p>
          ) : (
            <div className="flex flex-col gap-4">
              {l.type === 'auction' && (
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    if (!amountError && amount) void bid.request({ id: l.id, maxAmount: amountNum });
                  }}
                  className="flex flex-wrap items-end gap-3"
                >
                  <div className="w-[180px]">
                    <Field label="Your maximum bid" htmlFor="bid-amount" error={amountError} hint={l.minNextBid ? `Minimum ${num(l.minNextBid)}` : undefined}>
                      <input id="bid-amount" inputMode="numeric" value={amount} onChange={(e) => setAmount(e.target.value.replace(/\D/g, ''))} className={cx(inputClass, 'num')} aria-invalid={!!amountError} />
                    </Field>
                  </div>
                  <Button type="submit" variant="primary" icon={Gavel} busy={bid.busy} disabled={!amount || !!amountError}>
                    Review bid
                  </Button>
                </form>
              )}
              {buyNow !== null && (
                <div className="flex items-center justify-between gap-3 rounded-[var(--radius-ctl)] bg-ink-2 px-4 py-3">
                  <p className="text-sm">
                    Buy now for <span className="num font-display font-bold">{num(buyNow)}</span>
                  </p>
                  <Button icon={ShoppingCart} busy={buy.busy} onClick={() => void buy.request({ id: l.id })}>
                    Review purchase
                  </Button>
                </div>
              )}
            </div>
          )}
        </section>
      )}
      {bid.dialog}
      {buy.dialog}
    </div>
  );
}

function MarketActivity({ loggedIn }: { loggedIn: boolean }) {
  const actions = useActions();
  const mine = useQuery({ queryKey: ['market-mine'], queryFn: () => get<{ listings: unknown[]; bids: unknown[]; buyOrders: unknown[]; holds: unknown[] }>('/market/mine'), enabled: loggedIn });
  const now = useNow(30_000);
  const market = (actions.data ?? []).filter((a) => a.kind.startsWith('market.'));
  return (
    <div className="grid gap-4 lg:grid-cols-[300px_1fr]">
      <Panel title="On Kyara">
        {!loggedIn ? (
          <p className="text-sm text-muted">Connect your account to see this.</p>
        ) : !mine.data ? (
          <Skeleton className="h-28" />
        ) : (
          <dl className="grid grid-cols-2 gap-4">
            {(
              [
                ['Your listings', mine.data.listings.length],
                ['Active bids', mine.data.bids.length],
                ['Buy orders', mine.data.buyOrders.length],
                ['Chakra holds', mine.data.holds.length],
              ] as const
            ).map(([k, v]) => (
              <div key={k}>
                <dt className="text-xs text-muted">{k}</dt>
                <dd className="num font-display text-xl font-bold">{v}</dd>
              </div>
            ))}
          </dl>
        )}
      </Panel>
      <Panel title="Bids and purchases sent from this bot" bodyClass="p-0">
        {!actions.data ? (
          <div className="p-4">
            <Skeleton className="h-24" />
          </div>
        ) : market.length === 0 ? (
          <EmptyState icon={Gavel} title="No market action yet">
            Bids and purchases you make here are recorded with their outcome.
          </EmptyState>
        ) : (
          <ul className="divide-y divide-line">
            {market.map((a) => (
              <li key={a.id} className="flex items-start gap-3 px-4 py-3 text-sm">
                <span className="mt-1.5">
                  <StatusDot tone={a.status === 'succeeded' ? 'ok' : a.status === 'failed' ? 'bad' : 'warn'} />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="truncate">{a.summary}</p>
                  <p className="text-xs text-muted">
                    {a.status === 'unknown' ? 'Outcome unknown, resolve it in Activity' : a.status === 'failed' ? (a.error ?? 'Failed') : 'Done'}
                  </p>
                </div>
                <span className="shrink-0 text-xs text-faint">{ago(a.startedAt, now)}</span>
              </li>
            ))}
          </ul>
        )}
      </Panel>
    </div>
  );
}
