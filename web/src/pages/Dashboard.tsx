import { motion } from 'motion/react';
import { Link, Navigate, useNavigate } from 'react-router';
import { Bot, Layers, PlugZap, Sparkles } from 'lucide-react';
import { CharacterArt, RaritySeal } from '../components/character';
import { useToast } from '../components/overlay';
import { Button, EmptyState, ErrorState, Meter, PageHeader, Panel, Skeleton, StatusDot } from '../components/ui';
import { explain } from '../lib/api';
import { ago, describeGain, duration, num } from '../lib/format';
import { useCharacters, useClaim, useCollection, useListings, useMe, useMonitors, useNow, useProgress, useStatus, useEvents } from '../lib/queries';
import { RARITY, RARITY_ORDER } from '../lib/rarity';
import { desktop } from '../lib/desktop';

const SETUP_SEEN = 'kyara.setupSeen';
const setupSeen = () => {
  try {
    return localStorage.getItem(SETUP_SEEN) === '1';
  } catch {
    return true;
  }
};

export function Dashboard() {
  const status = useStatus();
  const monitors = useMonitors();
  const loggedIn = !!status.data?.session.hasToken;
  // first run (no session, no monitor): the setup wizard
  if (status.data && monitors.data && !loggedIn && monitors.data.monitors.length === 0 && !setupSeen()) return <Navigate to="/setup" replace />;
  return (
    <>
      <PageHeader title="Dashboard" description="Your account, collection and automation at a glance." />
      {status.isError && <ErrorState message={explain(status.error)} onRetry={() => void status.refetch()} />}
      <div className="grid gap-4 lg:grid-cols-12 [&>*]:min-w-0">
        <div className="lg:col-span-12">{status.data && !loggedIn ? <ConnectPrompt /> : <AccountStrip />}</div>
        <div className="lg:col-span-7">
          <CollectionProgress enabled={loggedIn} />
        </div>
        <div className="lg:col-span-5">
          <MissionsSummary enabled={loggedIn} />
        </div>
        <div className="lg:col-span-12">
          <RecentPulls enabled={loggedIn} />
        </div>
        <div className="lg:col-span-7">
          <EndingSoon />
        </div>
        <div className="lg:col-span-5">
          <AutomationSummary />
        </div>
      </div>
    </>
  );
}

function ConnectPrompt() {
  return (
    <Panel>
      <div className="flex flex-wrap items-center gap-4">
        <PlugZap size={22} className="text-warn" aria-hidden />
        <div className="min-w-0 flex-1">
          <p className="font-bold">Connect your Kyara account</p>
          <p className="text-sm text-muted">
            {desktop ? 'Log in on Kyara in the app’s Kyara window' : 'Pair the browser extension (or import a token)'} to see your chakra, collection and missions. Public data below works without it.
          </p>
        </div>
        {desktop ? (
          <Button variant="primary" onClick={() => void desktop?.openKyara()}>
            Log in to Kyara
          </Button>
        ) : (
          <Link to="/setup" className="inline-flex h-10 items-center rounded-[var(--radius-ctl)] bg-washi px-4 font-bold text-ink-0 hover:bg-washi-hi">
            Set up the session
          </Link>
        )}
      </div>
    </Panel>
  );
}

function AccountStrip() {
  const me = useMe();
  const now = useNow(1000);
  if (me.isError) return <ErrorState message={explain(me.error)} onRetry={() => void me.refetch()} />;
  if (!me.data)
    return (
      <Panel>
        <div className="flex gap-8">
          <Skeleton className="h-14 w-48" />
          <Skeleton className="h-14 w-40" />
          <Skeleton className="h-14 w-40" />
        </div>
      </Panel>
    );
  const { wallet: w, profile } = me.data;
  const nextIn = w.nextFreeAt ? Date.parse(w.nextFreeAt) - now : null;
  return (
    <section aria-label="Account" className="grid grid-cols-2 gap-px overflow-hidden rounded-[var(--radius-panel)] bg-line lg:grid-cols-4">
      <Stat label="Chakra">
        <p className="num font-display text-2xl font-bold leading-none sm:text-3xl">{num(w.chakra)}</p>
        <p className="mt-2 text-sm text-muted">{w.chakraHeld > 0 ? `${num(w.chakraHeld)} more reserved in bids` : `Account: ${profile.pseudo ?? 'you'}`}</p>
      </Stat>
      <Stat label="Free packs">
        <p className="num font-display text-2xl font-bold leading-none sm:text-3xl">
          {w.freePacks}
          <span className="text-lg text-faint">/{w.freePacksMax}</span>
        </p>
        <div className="mt-3">
          <Meter value={w.freePacks} max={w.freePacksMax} label="Free packs" />
        </div>
        <p className="num mt-2 text-sm text-muted">{w.freePacks >= w.freePacksMax ? 'Full: Kyara refills again once some are opened' : nextIn !== null ? `Next in ${duration(nextIn)}` : 'Regenerating'}</p>
      </Stat>
      <Stat label="Mythic guarantee">
        {w.pity ? (
          <>
            <p className="num font-display text-2xl font-bold leading-none sm:text-3xl">
              {w.pity.count}
              <span className="text-lg text-faint">/{w.pity.threshold}</span>
            </p>
            <div className="mt-3">
              <Meter value={w.pity.count} max={w.pity.threshold} color={RARITY.M.color} label="Openings toward a guaranteed Mythic" />
            </div>
            <p className="mt-2 text-sm text-muted">{w.pity.threshold - w.pity.count} openings to a sure Mythic</p>
          </>
        ) : (
          <p className="text-muted">Not reported</p>
        )}
      </Stat>
      <Stat label="Next golden pack">
        <p className="num font-display text-2xl font-bold leading-none sm:text-3xl">{w.goldenIn === 1 ? 'Next' : w.goldenIn ?? '–'}</p>
        <p className="mt-2 text-sm text-muted">
          {w.goldenIn === 1 ? 'Your next opening is golden' : 'openings to go'}
          {w.bonusPacks ? `. ${w.bonusPacks} bonus pack${w.bonusPacks > 1 ? 's' : ''} waiting` : ''}
        </p>
      </Stat>
    </section>
  );
}

function Stat({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="bg-ink-1 p-4 sm:p-5">
      <p className="mb-3 text-sm text-muted">{label}</p>
      {children}
    </div>
  );
}

function CollectionProgress({ enabled }: { enabled: boolean }) {
  const col = useCollection(enabled);
  return (
    <Panel title="Collection" action={<Link to="/collection" className="text-sm text-focus underline-offset-4 hover:underline">Open collection</Link>}>
      {!enabled ? (
        <p className="text-sm text-muted">Available once your account is connected.</p>
      ) : col.isError ? (
        <ErrorState compact message={explain(col.error)} onRetry={() => void col.refetch()} />
      ) : !col.data ? (
        <Skeleton className="h-44" />
      ) : (
        <div>
          <div className="mb-4 flex items-baseline gap-3">
            <p className="num font-display text-2xl font-bold">{col.data.stats.completionPct}%</p>
            <p className="num text-sm text-muted">
              {num(col.data.stats.unique)} of {num(col.data.stats.catalogSize)} characters, {num(col.data.stats.copies)} cards
            </p>
          </div>
          <ul className="flex flex-col gap-2.5">
            {RARITY_ORDER.map((r) => {
              const b = col.data.stats.byRarity[r];
              return (
                <li key={r} className="grid grid-cols-[22px_92px_1fr_88px] items-center gap-3 text-sm">
                  <RaritySeal rarity={r} size={20} />
                  <span className="text-washi-dim">{RARITY[r].name}</span>
                  <Meter value={b.owned} max={b.total} color={RARITY[r].color} label={`${RARITY[r].name}: ${b.owned} of ${b.total}`} />
                  <span className="num text-right text-muted">
                    {b.owned}/{b.total}
                  </span>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </Panel>
  );
}

function MissionsSummary({ enabled }: { enabled: boolean }) {
  const p = useProgress(enabled);
  const claim = useClaim();
  const toast = useToast();
  const now = useNow(30_000);
  return (
    <Panel title="Missions" action={<Link to="/missions" className="text-sm text-focus underline-offset-4 hover:underline">All missions</Link>}>
      {!enabled ? (
        <p className="text-sm text-muted">Available once your account is connected.</p>
      ) : p.isError ? (
        <ErrorState compact message={explain(p.error)} onRetry={() => void p.refetch()} />
      ) : !p.data ? (
        <Skeleton className="h-44" />
      ) : (
        <div className="flex flex-col gap-4">
          <div className="flex items-center justify-between gap-3">
            <div>
              <p className="num font-display text-2xl font-bold">{p.data.claimable}</p>
              <p className="text-sm text-muted">{p.data.claimable === 1 ? 'reward to claim' : 'rewards to claim'}</p>
            </div>
            <Button
              variant="primary"
              icon={Sparkles}
              disabled={p.data.claimable === 0}
              busy={claim.isPending}
              onClick={() =>
                claim.mutate(
                  { kind: 'all' },
                  {
                    onSuccess: (r) => r.status === 'succeeded' && toast({ kind: 'success', title: 'Rewards claimed', detail: describeGain(r.result.gained) }),
                    onError: (e) => toast({ kind: 'error', title: 'Could not claim', detail: explain(e) }),
                  },
                )
              }
            >
              Claim all
            </Button>
          </div>
          {(['daily', 'weekly'] as const).map((k) => {
            const block = p.data[k];
            if (!block) return null;
            const done = block.missions.filter((m) => m.done).length;
            return (
              <div key={k}>
                <div className="mb-1.5 flex justify-between text-sm">
                  <span className="text-washi-dim">{k === 'daily' ? 'Daily' : 'Weekly'} missions</span>
                  <span className="num text-muted">
                    {done}/{block.missions.length}
                  </span>
                </div>
                <Meter value={done} max={block.missions.length} label={`${k} missions done`} />
              </div>
            );
          })}
          {p.data.resets.nextDaily && <p className="num text-xs text-faint">Daily reset in {duration(Date.parse(p.data.resets.nextDaily) - now)}</p>}
        </div>
      )}
    </Panel>
  );
}


function RecentPulls({ enabled }: { enabled: boolean }) {
  const col = useCollection(enabled);
  const chars = useCharacters();
  const navigate = useNavigate();
  const byId = new Map((chars.data ?? []).map((c) => [c.id, c]));
  const recent = (col.data?.entries ?? [])
    .filter((e) => e.firstAt)
    .sort((a, b) => (b.firstAt ?? '').localeCompare(a.firstAt ?? ''))
    .slice(0, 10)
    .map((e) => ({ entry: e, c: byId.get(e.characterId) }))
    .filter((x) => x.c);
  return (
    <Panel title="Latest additions to your collection" action={<Link to="/collection?sort=recent" className="text-sm text-focus underline-offset-4 hover:underline">See all</Link>}>
      {!enabled ? (
        <p className="text-sm text-muted">Available once your account is connected.</p>
      ) : !col.data || !chars.data ? (
        <div className="flex gap-4 overflow-hidden">
          {Array.from({ length: 8 }, (_, i) => (
            <Skeleton key={i} className="aspect-[2/3] w-[112px] shrink-0" />
          ))}
        </div>
      ) : recent.length === 0 ? (
        <EmptyState icon={Layers} title="No cards yet" action={<Link to="/packs" className="text-focus underline">Open a pack</Link>} />
      ) : (
        <ul className="flex gap-4 overflow-x-auto pb-1">
          {recent.map(({ entry, c }, i) => (
            <motion.li key={entry.characterId} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: i * 0.03, duration: 0.24 }} className="w-[112px] shrink-0">
              <button type="button" onClick={() => navigate(`/characters?c=${c!.id}`)} className="block w-full text-left" aria-label={`${c!.name}, ${RARITY[c!.rarity].name}, added ${ago(entry.firstAt)}`}>
                <div className="relative">
                  <CharacterArt character={c!} sizes="112px" />
                  <RaritySeal rarity={c!.rarity} size={20} className="absolute left-1.5 top-1.5" />
                </div>
                <p className="mt-1.5 truncate text-sm font-bold">{c!.name}</p>
                <p className="text-xs text-faint">{ago(entry.firstAt)}</p>
              </button>
            </motion.li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

function EndingSoon() {
  const listings = useListings({ sort: 'ending', type: 'auction', pageSize: '20' }, { live: true });
  const now = useNow(1000);
  return (
    <Panel title="Auctions ending soon" action={<Link to="/market" className="text-sm text-focus underline-offset-4 hover:underline">Open the market</Link>} bodyClass="p-0">
      {listings.isError ? (
        <div className="p-4">
          <ErrorState compact message={explain(listings.error)} onRetry={() => void listings.refetch()} />
        </div>
      ) : !listings.data ? (
        <div className="space-y-2 p-4">
          {Array.from({ length: 5 }, (_, i) => (
            <Skeleton key={i} className="h-12" />
          ))}
        </div>
      ) : (
        <ul className="divide-y divide-line">
          {listings.data.items.filter((l) => Date.parse(l.endsAt) > now).slice(0, 6).map((l) => {
            const left = Date.parse(l.endsAt) - now;
            return (
              <li key={l.id}>
                <Link to={`/market?l=${l.id}`} className="grid grid-cols-[36px_minmax(0,1fr)_auto_84px] items-center gap-3 px-4 py-2.5 hover:bg-ink-2">
                  <div className="w-9">
                    <CharacterArt character={l.character} sizes="36px" />
                  </div>
                  <div className="min-w-0">
                    <p className="flex items-center gap-2 truncate font-bold">
                      <RaritySeal rarity={l.character.rarity} size={16} />
                      <span className="truncate">{l.character.name}</span>
                    </p>
                    <p className="truncate text-xs text-muted">{l.bidCount ? `${l.bidCount} bid${l.bidCount > 1 ? 's' : ''}` : 'No bid yet'}</p>
                  </div>
                  <span className="num font-display font-bold">{num(l.currentBid ?? l.price)}</span>
                  <span className={`num text-right text-sm ${left < 60_000 ? 'font-bold text-warn' : 'text-washi-dim'}`}>{left > 0 ? duration(left) : 'Ended'}</span>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </Panel>
  );
}

function AutomationSummary() {
  const mon = useMonitors();
  const events = useEvents();
  const now = useNow(10_000);
  const running = mon.data?.monitors.filter((m) => m.status.state === 'running').length ?? 0;
  const recent = (events.data ?? []).filter((e) => !e.type.startsWith('session')).slice(0, 6);
  return (
    <Panel title="Automation" action={<Link to="/automation" className="text-sm text-focus underline-offset-4 hover:underline">Monitors</Link>}>
      {!mon.data ? (
        <Skeleton className="h-36" />
      ) : (
        <>
          <div className="mb-3 flex items-center gap-2.5">
            <StatusDot tone={mon.data.pausedAll ? 'warn' : running ? 'live' : 'idle'} />
            <p className="text-sm">
              {mon.data.pausedAll ? 'All automation is paused' : running ? `${running} of ${mon.data.monitors.length} monitors running` : mon.data.monitors.length ? 'No monitor running' : 'No monitor yet'}
            </p>
          </div>
          {recent.length === 0 ? (
            <EmptyState icon={Bot} title="Nothing happened yet">
              Monitor events and bridge activity show up here.
            </EmptyState>
          ) : (
            <ul className="flex flex-col gap-2">
              {recent.map((e) => (
                <li key={e.id} className="flex items-start gap-2.5 text-sm">
                  <span className="mt-1.5">
                    <StatusDot tone={e.level === 'error' ? 'bad' : e.level === 'warn' ? 'warn' : e.level === 'success' ? 'ok' : 'idle'} />
                  </span>
                  <span className="min-w-0 flex-1 truncate">{e.title}</span>
                  <span className="shrink-0 text-xs text-faint">{ago(e.at, now)}</span>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </Panel>
  );
}
