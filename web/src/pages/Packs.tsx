import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router';
import { History, KeyRound, PackageOpen, X } from 'lucide-react';
import { CharacterArt, RaritySeal } from '../components/character';
import { useToast } from '../components/overlay';
import { Button, EmptyState, ErrorState, IconButton, PageHeader, Panel, Segmented, Skeleton, StatusDot, cx } from '../components/ui';
import { useConfirmFlow } from '../components/useConfirmFlow';
import { api, explain } from '../lib/api';
import { ago, duration, num } from '../lib/format';
import { queryClient, qk, useNow, usePackHistory, usePacks, useRates, useStatus } from '../lib/queries';
import { RARITY } from '../lib/rarity';
import type { ActionResponse, OpenSummary, PackView, PulledCard, Rarity } from '../lib/types';

type Tab = 'shelf' | 'history';

export function PacksPage() {
  const [tab, setTab] = useState<Tab>('shelf');
  return (
    <>
      <PageHeader
        title="Packs"
        description="Boosters available on Kyara, with what they cost you right now."
        actions={<Segmented<Tab> label="Packs view" layoutId="pk-tab" value={tab} onChange={setTab} options={[{ value: 'shelf', label: 'Packs' }, { value: 'history', label: 'Opening history' }]} />}
      />
      <AnimatePresence mode="wait" initial={false}>
        <motion.div key={tab} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -4 }} transition={{ duration: 0.18 }}>
          {tab === 'shelf' ? <Shelf /> : <OpeningHistory />}
        </motion.div>
      </AnimatePresence>
    </>
  );
}

function Shelf() {
  const packs = usePacks();
  const status = useStatus();
  const [selected, setSelected] = useState<string | null>(null);
  const now = useNow(1000);
  const views = useMemo(() => packs.data?.packs ?? [], [packs.data]);
  // The first openable pack is preselected once; the selection never moves after an opening.
  const initial = views.find((v) => v.access?.openable && v.affordable)?.pack.id ?? views[0]?.pack.id ?? null;
  if (selected === null && initial !== null) setSelected(initial);
  // Results live here, outside the per-pack panel, so a refetch or a click elsewhere cannot lose them.
  const [result, setResult] = useState<{ summary: OpenSummary; color: string } | null>(null);

  if (packs.isError) return <ErrorState message={explain(packs.error)} onRetry={() => void packs.refetch()} />;
  if (!packs.data)
    return (
      <div className="grid grid-cols-[repeat(auto-fill,minmax(180px,1fr))] gap-3">
        {Array.from({ length: 12 }, (_, i) => (
          <Skeleton key={i} className="h-[150px]" />
        ))}
      </div>
    );
  const current = views.find((v) => v.pack.id === selected) ?? null;

  return (
    <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_380px]">
      <div>
        {packs.data.loggedIn && (
          <p className="mb-3 text-sm text-muted">
            Balance <span className="num font-bold text-washi">{num(packs.data.chakra)}</span> chakra.{' '}
            {packs.data.passValidForMs ? (
              <span>Pack pass valid for {duration(packs.data.passValidForMs)}.</span>
            ) : packs.data.passRequired === false ? null : (
              <span className="text-warn">No pack pass: keep kyara.games open with the extension paired.</span>
            )}
          </p>
        )}
        <ul className="grid grid-cols-[repeat(auto-fill,minmax(180px,1fr))] gap-3" aria-label="Packs">
          {views.map((v) => (
            <li key={v.pack.id}>
              <PackTile view={v} selected={v.pack.id === selected} onSelect={() => setSelected(v.pack.id)} now={now} loggedIn={packs.data.loggedIn} />
            </li>
          ))}
        </ul>
      </div>
      <div className="lg:sticky lg:top-4 lg:self-start">
        <AnimatePresence mode="wait">
          {current && (
            <motion.div key={current.pack.id} initial={{ opacity: 0, x: 10 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -6 }} transition={{ duration: 0.2 }}>
              <PackPanel
                view={current}
                loggedIn={packs.data.loggedIn}
                hasPass={!!packs.data.passValidForMs || packs.data.passRequired === false}
                sessionOk={!!status.data?.session.hasToken}
                onOpened={(summary) => setResult({ summary, color: packColor(current) })}
              />
            </motion.div>
          )}
        </AnimatePresence>
      </div>
      <RevealStage result={result?.summary ?? null} color={result?.color ?? 'var(--color-washi)'} onClose={() => setResult(null)} />
    </div>
  );
}

function packColor(v: PackView): string {
  return (v.pack as { color?: string }).color ?? 'var(--color-washi)';
}
function packKanji(v: PackView): string {
  return (v.pack as { kanji?: string }).kanji ?? '包';
}

function PackTile({ view: v, selected, onSelect, now, loggedIn }: { view: PackView; selected: boolean; onSelect: () => void; now: number; loggedIn: boolean }) {
  const color = packColor(v);
  const a = v.access;
  const usable = !loggedIn || (a?.openable && v.affordable);
  const end = v.pack.schedule ? Date.parse(v.pack.schedule.end) - now : null;
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      className={cx(
        'group relative flex h-[150px] w-full flex-col overflow-hidden rounded-[var(--radius-panel)] bg-ink-1 p-4 text-left transition-[background-color,box-shadow] duration-150 hover:bg-ink-2',
        selected && 'bg-ink-2 shadow-[inset_0_0_0_1px_var(--color-line-strong)]',
        !usable && 'opacity-70',
      )}
    >
      {/* spine in the pack's own colour */}
      <span aria-hidden className="absolute inset-y-0 left-0 w-[3px]" style={{ background: color }} />
      <span aria-hidden className="pointer-events-none absolute -right-2 -top-4 text-[86px] font-bold leading-none opacity-[0.13] transition-transform duration-300 group-hover:-translate-y-1" style={{ color }}>
        {packKanji(v)}
      </span>
      <p className="relative font-bold text-washi">{v.pack.name}</p>
      <p className="relative mt-0.5 line-clamp-1 text-xs text-muted">{v.pack.sub}</p>
      <div className="relative mt-auto flex gap-1" aria-label={`Slots: ${v.pack.slots?.join(' ') ?? ''}`}>
        {(v.pack.slots ?? []).slice(0, 12).map((s, i) => (
          <span key={i} aria-hidden className="h-1.5 w-3 rounded-full" style={{ background: RARITY[s as Rarity]?.color ?? 'var(--color-faint)' }} />
        ))}
      </div>
      <p className="relative mt-2 text-sm">
        {!loggedIn ? (
          <span className="num text-washi-dim">{num(v.pack.chakraPrice ?? v.pack.price)} chakra</span>
        ) : !a?.openable ? (
          <span className="text-muted">{a?.reason ?? 'Unavailable'}</span>
        ) : a.chakra === 0 ? (
          <span className="text-ok">{a.reason}</span>
        ) : (
          <span className={cx('num', v.affordable ? 'text-washi' : 'text-muted')}>{num(a.chakra)} chakra</span>
        )}
        {end !== null && end > 0 && <span className="num text-faint"> · ends in {duration(end)}</span>}
      </p>
    </button>
  );
}

function PackPanel({
  view: v,
  loggedIn,
  hasPass,
  sessionOk,
  onOpened,
}: {
  view: PackView;
  loggedIn: boolean;
  hasPass: boolean;
  sessionOk: boolean;
  onOpened: (r: OpenSummary) => void;
}) {
  const rates = useRates(v.pack.id);
  const [count, setCount] = useState<'1' | '5' | '10'>('1');
  const toast = useToast();
  const color = packColor(v);
  const flow = useConfirmFlow<{ packId: string; count: number }, OpenSummary>({
    run: (x) => api<ActionResponse<OpenSummary>>(`/packs/${encodeURIComponent(x.packId)}/open`, { method: 'POST', body: { count: x.count, [x.mode]: true } }),
    title: 'Open this pack?',
    confirmLabel: 'Open',
    skipWhenFree: true,
    onSuccess: (r) => {
      onOpened(r);
      for (const k of [qk.packs, qk.me, qk.collection, qk.packHistory, qk.actions]) void queryClient.invalidateQueries({ queryKey: k });
      if (r.stopped) toast({ kind: 'warn', title: `Stopped after ${r.opened}`, detail: r.stopped.message ?? r.stopped.code });
    },
  });
  const a = v.access;
  const canOpen = loggedIn && sessionOk && !!a?.openable && !!v.affordable && hasPass;
  const why = !loggedIn || !sessionOk ? 'Connect your account to open packs.' : !a?.openable ? `Not openable now: ${a?.reason}.` : !v.affordable ? 'Not enough chakra.' : !hasPass ? 'Needs a pack pass from your open kyara.games tab.' : null;

  return (
    <Panel bodyClass="p-0">
      <div className="relative overflow-hidden border-b border-line p-5">
        <span aria-hidden className="absolute inset-x-0 top-0 h-[3px]" style={{ background: color }} />
        <div className="flex items-start gap-4">
          <span aria-hidden className="grid h-14 w-14 shrink-0 rotate-[-4deg] place-items-center rounded-[4px] border-2 text-[28px] font-bold" style={{ borderColor: color, color }}>
            {packKanji(v)}
          </span>
          <div className="min-w-0">
            <h2 className="font-display text-lg font-bold">{v.pack.name}</h2>
            <p className="text-sm text-muted">{v.pack.sub}</p>
            {v.pack.rates?.poolSize && <p className="num mt-1 text-xs text-faint">{num(v.pack.rates.poolSize)} characters in the pool</p>}
          </div>
        </div>
      </div>

      <div className="p-5">
        <h3 className="mb-2 text-sm font-bold text-washi-dim">Chance per booster to get at least one</h3>
        {!rates.data ? (
          <Skeleton className="h-36" />
        ) : (
          <ul className="flex flex-col gap-2">
            {[...rates.data].reverse().map((r) => (
              <li key={r.rarity} className="grid grid-cols-[22px_1fr_70px] items-center gap-3 text-sm">
                <RaritySeal rarity={r.rarity} size={18} />
                <span className="h-1.5 overflow-hidden rounded-full bg-ink-3" aria-hidden>
                  <span className="block h-full rounded-full" style={{ width: `${Math.max(1, r.boosterPct)}%`, background: RARITY[r.rarity].color }} />
                </span>
                <span className="num text-right">{r.boosterPct < 1 ? r.boosterPct.toFixed(2) : r.boosterPct.toFixed(1)}%</span>
              </li>
            ))}
          </ul>
        )}
        {v.pack.rates?.pity?.rarity && (
          <p className="mt-3 text-xs text-faint">
            Guaranteed {RARITY[v.pack.rates.pity.rarity as Rarity]?.name ?? v.pack.rates.pity.rarity} within {v.pack.rates.pity.threshold} openings.
          </p>
        )}
      </div>

      <div className="border-t border-line p-5">
        <div className="flex flex-wrap items-center gap-3">
          <Segmented<'1' | '5' | '10'> label="How many" layoutId="pk-count" value={count} onChange={setCount} options={[{ value: '1', label: '×1' }, { value: '5', label: '×5' }, { value: '10', label: '×10' }]} />
          <Button variant="primary" icon={PackageOpen} className="flex-1" disabled={!canOpen} busy={flow.busy} onClick={() => void flow.request({ packId: v.pack.id, count: Number(count) })}>
            {flow.busy ? 'Opening…' : `Open ${count === '1' ? 'one' : count}`}
          </Button>
        </div>
        {why && (
          <p className="mt-3 flex items-center gap-2 text-sm text-muted">
            {why.includes('pass') && <KeyRound size={14} aria-hidden />}
            {why}{' '}
            {(why.includes('pass') || why.includes('Connect')) && (
              <Link to="/session" className="text-focus underline underline-offset-4">
                Session
              </Link>
            )}
          </p>
        )}
        <p className="mt-3 text-xs text-faint">Free and bonus packs open on click. Anything that spends chakra asks first, with the exact cost from Kyara.</p>
      </div>
      {flow.dialog}
    </Panel>
  );
}

/**
 * The one orchestrated moment. It only runs once Kyara has confirmed the opening:
 * cards arrive face down and flip in rarity order. "Reveal all" skips; reduced motion shows all at once.
 */
function RevealStage({ result, color, onClose }: { result: OpenSummary | null; color: string; onClose: () => void }) {
  const reduce = useReducedMotion();
  const cards = useMemo(() => (result ? [...result.cards].sort((a, b) => RARITY[a.rarity].rank - RARITY[b.rarity].rank) : []), [result]);
  const [shown, setShown] = useState(0);
  const [forResult, setForResult] = useState<OpenSummary | null>(null);
  if (result !== forResult) {
    setForResult(result);
    setShown(reduce ? cards.length : 0);
  }
  useEffect(() => {
    if (!result || shown >= cards.length) return;
    const t = setTimeout(() => setShown((n) => n + 1), shown === 0 ? 450 : 260);
    return () => clearTimeout(t);
  }, [result, shown, cards.length]);
  useEffect(() => {
    if (!result) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [result, onClose]);
  const done = shown >= cards.length;
  const best = cards.at(-1);

  return (
    <AnimatePresence>
      {result && (
        <motion.div
          role="dialog"
          aria-modal="true"
          aria-label="Opening results"
          className="fixed inset-0 z-50 flex flex-col bg-ink-0/95 backdrop-blur-sm"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0, transition: { duration: 0.15 } }}
        >
          <div className="flex items-center justify-between px-6 py-4">
            <p className="font-display text-lg font-bold">
              {result.godPacks ? 'Divine pack' : result.goldenPacks ? 'Golden pack' : `${result.opened} pack${result.opened > 1 ? 's' : ''} opened`}
            </p>
            <div className="flex items-center gap-2">
              {!done && (
                <Button size="sm" variant="ghost" onClick={() => setShown(cards.length)}>
                  Reveal all
                </Button>
              )}
              <IconButton icon={X} label="Close results" onClick={onClose} />
            </div>
          </div>
          <div className="flex min-h-0 flex-1 items-center justify-center overflow-y-auto px-6 pb-6">
            <ul className="grid w-full max-w-[1100px] grid-cols-[repeat(auto-fit,minmax(130px,160px))] justify-center gap-4" aria-live="polite">
              {cards.map((c, i) => (
                <li key={`${c.id}-${i}`} style={{ perspective: 900 }}>
                  <FlipCard card={c} revealed={i < shown} color={color} />
                </li>
              ))}
            </ul>
          </div>
          <AnimatePresence>
            {done && (
              <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.25 }} className="border-t border-line bg-ink-1 px-6 py-4">
                <div className="mx-auto flex max-w-[1100px] flex-wrap items-center gap-x-8 gap-y-2">
                  <p>
                    <span className="num font-display text-xl font-bold">{result.newCards}</span> <span className="text-muted">new for your collection</span>
                  </p>
                  {best && (
                    <p className="flex items-center gap-2">
                      <span className="text-muted">Best pull</span> <RaritySeal rarity={best.rarity} size={20} /> <span className="font-bold">{best.name}</span>
                    </p>
                  )}
                  {Number.isFinite(result.chakraAfter) && (
                    <p className="num text-muted">
                      Chakra now <span className="font-bold text-washi">{num(result.chakraAfter)}</span>
                    </p>
                  )}
                  <Button className="ml-auto" variant="primary" onClick={onClose} data-autofocus>
                    Done
                  </Button>
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

function FlipCard({ card, revealed, color }: { card: PulledCard; revealed: boolean; color: string }) {
  const r = RARITY[card.rarity];
  const high = r.rank >= 3;
  return (
    <motion.div
      className="relative aspect-[2/3] w-full [transform-style:preserve-3d]"
      initial={{ rotateY: 180, y: 18, opacity: 0 }}
      animate={{ rotateY: revealed ? 0 : 180, y: 0, opacity: 1 }}
      transition={{ rotateY: { duration: 0.5, ease: [0.2, 0.8, 0.2, 1] }, y: { duration: 0.3 }, opacity: { duration: 0.3 } }}
      aria-hidden={!revealed}
    >
      <div className="absolute inset-0 [backface-visibility:hidden]">
        <CharacterArt character={card} eager sizes="160px" />
        <span aria-hidden className="absolute inset-x-0 bottom-0 h-[3px]" style={{ background: r.color }} />
        {high && revealed && <motion.span aria-hidden className="absolute inset-0 rounded-[var(--radius-art)]" initial={{ boxShadow: `0 0 0 0 ${r.color}` }} animate={{ boxShadow: `0 0 0 2px ${r.color}, 0 0 28px -4px ${r.color}` }} transition={{ duration: 0.4, delay: 0.25 }} />}
        <RaritySeal rarity={card.rarity} size={24} className="absolute left-2 top-2" />
        {card.isNew && <span className="absolute right-2 top-2 rounded-[var(--radius-chip)] bg-washi px-1.5 text-xs font-bold text-ink-0">New</span>}
        <div className="absolute inset-x-0 -bottom-12">
          <p className="truncate text-sm font-bold">{card.name}</p>
          <p className="truncate text-xs text-muted">{card.series}</p>
        </div>
      </div>
      <div className="absolute inset-0 grid place-items-center rounded-[var(--radius-art)] bg-ink-2 [backface-visibility:hidden] [transform:rotateY(180deg)]" style={{ boxShadow: `inset 0 0 0 2px ${color}` }}>
        <span className="rotate-[-4deg] text-4xl font-bold opacity-60" style={{ color }}>
          キ
        </span>
      </div>
    </motion.div>
  );
}

function OpeningHistory() {
  const h = usePackHistory();
  const now = useNow(30_000);
  if (h.isError) return <ErrorState message={explain(h.error)} onRetry={() => void h.refetch()} />;
  if (!h.data) return <Skeleton className="h-48" />;
  if (h.data.length === 0)
    return (
      <EmptyState icon={History} title="No opening yet">
        Packs opened from this bot are listed here with what they gave.
      </EmptyState>
    );
  return (
    <Panel bodyClass="p-0">
      <ul className="divide-y divide-line">
        {h.data.map((a) => {
          const rar = String(a.result?.rarities ?? '');
          return (
            <li key={a.id} className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-4 px-4 py-3 text-sm">
              <StatusDot tone={a.status === 'succeeded' ? 'ok' : a.status === 'failed' ? 'bad' : 'warn'} />
              <div className="min-w-0">
                <p className="truncate">{a.summary}</p>
                {a.status === 'succeeded' ? (
                  <p className="mt-1 flex flex-wrap items-center gap-1" aria-label={`Rarities: ${rar}`}>
                    {[...rar].map((x, i) => (
                      <span key={i} aria-hidden className="h-2 w-2 rounded-full" style={{ background: RARITY[x as Rarity]?.color ?? 'var(--color-faint)' }} />
                    ))}
                    <span className="ml-2 text-xs text-muted">{String(a.result?.newCards ?? 0)} new</span>
                  </p>
                ) : (
                  <p className="text-xs text-muted">{a.status === 'unknown' ? 'Outcome unknown: check Activity' : (a.error ?? 'Failed')}</p>
                )}
              </div>
              <span className="text-xs text-faint">{ago(a.startedAt, now)}</span>
            </li>
          );
        })}
      </ul>
    </Panel>
  );
}
