import { AnimatePresence, motion } from 'motion/react';
import { useId, useState } from 'react';
import { Link } from 'react-router';
import { ArrowLeftRight, Bot, ChevronDown, Pause, Pencil, Play, Plus, Trash2, Wallet } from 'lucide-react';
import { ConfirmDialog, Drawer, useToast } from '../components/overlay';
import { Button, EmptyState, ErrorState, Field, IconButton, PageHeader, Panel, Segmented, Skeleton, StatusDot, cx, inputClass } from '../components/ui';
import { explain } from '../lib/api';
import { ago, dateTime, num } from '../lib/format';
import { useMonitorMutations, useMonitors, useNow, usePacks, useStatus } from '../lib/queries';
import { RARITY, RARITY_ORDER } from '../lib/rarity';
import type { Monitor, MonitorInput, MonitorKind, MonitorState, Rarity, TradeParams } from '../lib/types';

const STATE: Record<MonitorState, { label: string; tone: 'live' | 'idle' | 'warn' | 'bad' }> = {
  running: { label: 'Running', tone: 'live' },
  stopped: { label: 'Stopped', tone: 'idle' },
  paused: { label: 'Paused', tone: 'warn' },
  error: { label: 'Stopped on error', tone: 'bad' },
  'needs-session': { label: 'Needs a session', tone: 'warn' },
};

export function AutomationPage() {
  const mon = useMonitors();
  const status = useStatus();
  const m = useMonitorMutations();
  const toast = useToast();
  const [editing, setEditing] = useState<Monitor | 'new' | null>(null);
  const [deleting, setDeleting] = useState<Monitor | null>(null);

  const running = mon.data?.monitors.filter((x) => x.status.state === 'running').length ?? 0;
  const paused = !!mon.data?.pausedAll;
  return (
    <>
      <PageHeader
        title="Monitors"
        description="Monitors watch Kyara and tell you what matters. Spending is off unless you allow it in Settings and per monitor."
        actions={
          <Button variant="primary" icon={Plus} onClick={() => setEditing('new')}>
            New monitor
          </Button>
        }
      />

      <section
        aria-label="Automation status"
        className={cx('mb-4 flex flex-wrap items-center gap-4 rounded-[var(--radius-panel)] p-4', paused ? 'border border-warn/40 bg-warn/5' : 'bg-ink-1')}
      >
        <StatusDot tone={paused ? 'warn' : running ? 'live' : 'idle'} />
        <div className="min-w-0 flex-1">
          <p className="font-bold">{paused ? 'All automation is paused' : running ? `${running} monitor${running > 1 ? 's' : ''} running` : 'Nothing is running'}</p>
          <p className="text-sm text-muted">{paused ? 'No monitor will run until you resume, even enabled ones.' : 'Pausing stops every monitor at once and keeps them stopped.'}</p>
        </div>
        {paused ? (
          <Button icon={Play} busy={m.resumeAll.isPending} onClick={() => m.resumeAll.mutate(undefined, { onError: (e) => toast({ kind: 'error', title: 'Could not resume', detail: explain(e) }) })}>
            Resume automation
          </Button>
        ) : (
          <Button variant="danger" icon={Pause} busy={m.pauseAll.isPending} onClick={() => m.pauseAll.mutate(undefined, { onError: (e) => toast({ kind: 'error', title: 'Could not pause', detail: explain(e) }) })}>
            Pause everything
          </Button>
        )}
      </section>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_300px] lg:items-start">
        <div>
          {mon.isError ? (
            <ErrorState message={explain(mon.error)} onRetry={() => void mon.refetch()} />
          ) : !mon.data ? (
            <Skeleton className="h-48" />
          ) : mon.data.monitors.length === 0 ? (
            <Panel>
              <EmptyState icon={Bot} title="No monitor yet" action={<Button icon={Plus} onClick={() => setEditing('new')}>Create a monitor</Button>}>
                Watch auctions for a character under a price, or get told when free packs fill up and rewards are ready.
              </EmptyState>
            </Panel>
          ) : (
            <ul className="flex flex-col gap-3">
              <AnimatePresence initial={false}>
                {mon.data.monitors.map((x) => (
                  <motion.li key={x.id} layout initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, x: 20 }} transition={{ duration: 0.2 }}>
                    <MonitorRow monitor={x} onEdit={() => setEditing(x)} onDelete={() => setDeleting(x)} />
                  </motion.li>
                ))}
              </AnimatePresence>
            </ul>
          )}
        </div>
        <Panel title="Spending limits">
          {!status.data ? (
            <Skeleton className="h-28" />
          ) : (
            <dl className="flex flex-col gap-3 text-sm">
              <div>
                <dt className="text-muted">Per action</dt>
                <dd className="num">Up to {num(status.data.automation.maxSpendPerAction)} chakra without an override</dd>
              </div>
              <div>
                <dt className="text-muted">Automatic bidding</dt>
                <dd className={status.data.automation.autoBidAllowedByConfig ? 'text-ok' : 'text-washi-dim'}>
                  {status.data.automation.autoBidAllowedByConfig ? 'Allowed, within its budget' : 'Off (turn it on in Settings)'}
                </dd>
              </div>
              <div>
                <dt className="text-muted">Automatic trades</dt>
                <dd className={status.data.automation.autoTradeAllowedByConfig ? 'text-ok' : 'text-washi-dim'}>
                  {status.data.automation.autoTradeAllowedByConfig
                    ? `Allowed${status.data.automation.autoTradeBudget ? `, up to ${num(status.data.automation.autoTradeBudget)} chakra pending` : ', card-for-card only'}`
                    : 'Preview only (turn it on in Settings)'}
                </dd>
              </div>
              <p className="text-xs text-faint">
                Set in{' '}
                <Link to="/settings" className="text-focus underline-offset-4 hover:underline">
                  Settings
                </Link>{' '}
                and enforced by the bot, whatever a monitor asks for.
              </p>
            </dl>
          )}
        </Panel>
      </div>

      <MonitorEditor
        open={editing !== null}
        initial={editing === 'new' ? null : editing}
        autoBidAllowed={!!status.data?.automation.autoBidAllowedByConfig}
        autoTradeAllowed={!!status.data?.automation.autoTradeAllowedByConfig}
        onClose={() => setEditing(null)}
      />
      <ConfirmDialog
        open={!!deleting}
        title="Delete this monitor?"
        summary={deleting ? `“${deleting.name}” stops and its configuration is removed.` : null}
        cost={null}
        confirmLabel="Delete"
        busy={m.remove.isPending}
        onClose={() => setDeleting(null)}
        onConfirm={() => deleting && m.remove.mutate(deleting.id, { onSuccess: () => setDeleting(null), onError: (e) => toast({ kind: 'error', title: 'Could not delete', detail: explain(e) }) })}
      />
    </>
  );
}

function describe(m: Monitor, packName: (id: string) => string): string {
  if (m.kind === 'trades') {
    const p = m.params;
    const what = [p.seek.enabled && 'gives spare copies to seekers', p.offer.enabled && 'asks for wishlist cards on offer'].filter(Boolean);
    return `Market chat${p.rooms ? ` rooms ${p.rooms.join(', ')}` : ''}: ${what.join(' and ') || 'nothing enabled'}`;
  }
  if (m.kind === 'account') {
    const p = m.params;
    const extras = [p.autoClaim && 'claims rewards', p.autoOpenFreePack && `opens ${packName(p.autoOpenFreePack)} while free`].filter(Boolean);
    return `Free packs, rewards and new packs${extras.length ? `; ${extras.join(', ')}` : ''}`;
  }
  const p = m.params;
  const what = [p.q && `“${p.q}”`, p.characterId && `character ${p.characterId}`, p.rarity && RARITY[p.rarity].name, p.series, p.type === 'auction' ? 'auctions' : p.type === 'fixed' ? 'fixed price' : null].filter(Boolean);
  const bid = p.autoBid.enabled ? `; bids for ${p.autoBid.copies} cop${p.autoBid.copies === 1 ? 'y' : 'ies'}` : '';
  return `${what.length ? what.join(', ') : 'All listings'}${p.maxPrice ? ` up to ${num(p.maxPrice)}` : ''}${bid}`;
}

function MonitorRow({ monitor: x, onEdit, onDelete }: { monitor: Monitor; onEdit: () => void; onDelete: () => void }) {
  const m = useMonitorMutations();
  const toast = useToast();
  const now = useNow(5000);
  const [open, setOpen] = useState(false);
  const packs = usePacks();
  const st = STATE[x.status.state];
  const histId = useId();
  const packName = (id: string) => packs.data?.packs.find((p) => p.pack.id === id)?.pack.name ?? id;
  const c = x.status.copies;
  return (
    <div className="rounded-[var(--radius-panel)] bg-ink-1">
      <div className="flex flex-wrap items-center gap-4 p-4">
        <Switch
          checked={x.enabled}
          label={`${x.enabled ? 'Disable' : 'Enable'} ${x.name}`}
          busy={m.toggle.isPending}
          onChange={(v) => m.toggle.mutate({ id: x.id, enabled: v }, { onError: (e) => toast({ kind: 'error', title: 'Could not change the monitor', detail: explain(e) }) })}
        />
        <div className="min-w-0 flex-1">
          <p className="flex items-center gap-2 font-bold">
            {x.name}
            <span className="rounded-[var(--radius-chip)] bg-ink-3 px-1.5 text-xs font-normal text-washi-dim">{KIND_LABEL[x.kind]}</span>
            {x.kind === 'trades' && (
              <span className={cx('inline-flex items-center gap-1 rounded-[var(--radius-chip)] px-1.5 text-xs font-normal', x.status.trades?.mode === 'auto' ? 'bg-warn/15 text-warn' : 'bg-ink-3 text-washi-dim')}>
                <ArrowLeftRight size={12} aria-hidden /> {x.status.trades?.mode === 'auto' ? 'Sends trades' : 'Preview'}
              </span>
            )}
            {x.kind === 'auctions' && x.params.autoBid.enabled && (
              <span className="inline-flex items-center gap-1 rounded-[var(--radius-chip)] bg-warn/15 px-1.5 text-xs font-normal text-warn">
                <Wallet size={12} aria-hidden /> Spends
              </span>
            )}
          </p>
          <p className="truncate text-sm text-muted">{describe(x, packName)}</p>
        </div>
        <div className="flex items-center gap-2 text-sm">
          <StatusDot tone={st.tone} />
          <span>{st.label}</span>
        </div>
        <div className="flex items-center gap-1">
          <IconButton icon={Pencil} label={`Edit ${x.name}`} onClick={onEdit} />
          <IconButton icon={Trash2} label={`Delete ${x.name}`} onClick={onDelete} />
          <IconButton icon={ChevronDown} label={open ? 'Hide run history' : 'Show run history'} aria-expanded={open} aria-controls={histId} onClick={() => setOpen((o) => !o)} className={cx('transition-transform', open && 'rotate-180')} />
        </div>
      </div>
      <div className="flex flex-wrap gap-x-6 gap-y-1 border-t border-line px-4 py-2.5 text-xs text-muted">
        <span>Every {x.intervalSec % 60 === 0 ? `${x.intervalSec / 60} min` : x.intervalSec > 60 ? `${Math.floor(x.intervalSec / 60)} min ${x.intervalSec % 60} s` : `${x.intervalSec} s`}</span>
        <span>Last run {ago(x.status.lastRunAt, now)}</span>
        <span>Last success {ago(x.status.lastOkAt, now)}</span>
        {x.status.autoBid && c && (
          <span className="num text-washi-dim">
            {c.won} of {x.status.autoBid.copies} cop{x.status.autoBid.copies === 1 ? 'y' : 'ies'} won{c.leading ? `, leading on ${c.leading}` : ''}
          </span>
        )}
        {x.status.autoBid && (
          <span className="num text-warn">
            {num(x.status.reserved)} of {num(x.status.autoBid.budget)} chakra committed, up to {num(x.status.autoBid.maxBid)} per copy
          </span>
        )}
        {!x.status.autoBid && c && c.won > 0 && <span className="num text-washi-dim">{c.won} won so far</span>}
        {x.status.autoBidHalted && <span className="text-bad">Auto-bid stopped after an unclear outcome. Check the listing on Kyara, then save the monitor to resume.</span>}
        {x.status.autoBidBlockedReason && <span className="text-warn">Auto-bid off: {x.status.autoBidBlockedReason}</span>}
        {x.status.trades && (
          <span className="num text-washi-dim">
            {x.status.trades.pending} pending, {x.status.trades.accepted} accepted, {x.status.trades.declined} declined, {x.status.trades.expired} cancelled unanswered
          </span>
        )}
        {x.status.trades?.halted && <span className="text-bad">Trading stopped after an unclear outcome. Check your trades on Kyara, then save the monitor to resume.</span>}
        {x.status.tradeBlockedReason && <span className="text-warn">{x.status.tradeBlockedReason}</span>}
        {x.status.lastError && <span className="text-bad">{x.status.lastError}</span>}
      </div>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div id={histId} initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={{ duration: 0.22 }} className="overflow-hidden border-t border-line">
            {x.status.history.length === 0 ? (
              <p className="px-4 py-3 text-sm text-muted">No run yet.</p>
            ) : (
              <ol className="max-h-56 overflow-y-auto py-1 text-xs">
                {x.status.history.map((h, i) => (
                  <li key={i} className="grid grid-cols-[auto_150px_70px_minmax(0,1fr)] items-center gap-3 px-4 py-1.5">
                    <StatusDot tone={h.ok ? 'ok' : 'bad'} />
                    <span className="text-washi-dim">{dateTime(h.at)}</span>
                    <span className="num text-faint">{h.ms} ms</span>
                    <span className="truncate text-bad">{h.error ?? ''}</span>
                  </li>
                ))}
              </ol>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function Switch({ checked, onChange, label, busy }: { checked: boolean; onChange: (v: boolean) => void; label: string; busy?: boolean }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={busy}
      onClick={() => onChange(!checked)}
      className={cx('relative block h-6 w-11 shrink-0 rounded-full p-0 transition-colors duration-200 disabled:opacity-60', checked ? 'bg-ok' : 'bg-ink-3')}
    >
      <motion.span aria-hidden className="absolute left-0 top-0.5 block h-5 w-5 rounded-full bg-washi shadow-sm" initial={false} animate={{ x: checked ? 22 : 2 }} transition={{ type: 'spring', stiffness: 600, damping: 36 }} />
    </button>
  );
}

const KIND_LABEL: Record<MonitorKind, string> = { auctions: 'Market', account: 'Account', trades: 'Trades' };
const FLOOR: Record<MonitorKind, number> = { auctions: 30, account: 120, trades: 60 };

const TRADE_BLANK: TradeParams = {
  mode: 'preview',
  rooms: null,
  maxAgeMin: 10,
  message: 'Hi {pseudo}! Saw your {name} in the market chat.',
  give: { keep: 0, rarities: [], exclude: [] },
  seek: { enabled: true, wishMinPct: 80, wishMaxPct: 130, allowChakra: true, markupPct: 110 },
  offer: { enabled: true, payWithCards: true, payWithChakra: true, minPayPct: 80, maxPayPct: 110, maxChakra: 200, maxCards: 3, onlyMissing: true },
  limits: { maxPending: 3, maxPerHour: 5, perUserHours: 24, expireMin: 30, budget: 0 },
};

const blank = (kind: MonitorKind): MonitorInput =>
  kind === 'auctions'
    ? { kind, name: 'Ending auctions', enabled: true, intervalSec: 60, params: { endingSoonSec: 300, pages: 1, type: 'auction', autoBid: { enabled: false, budget: 0, maxBid: 0, withinSec: 120, copies: 1 } } }
    : kind === 'trades'
      ? { kind, name: 'Chat trades', enabled: true, intervalSec: 90, params: TRADE_BLANK }
      : { kind, name: 'Account watch', enabled: true, intervalSec: 300, params: { autoClaim: false, autoOpenFreePack: null } };

function MonitorEditor({ open, initial, autoBidAllowed, autoTradeAllowed, onClose }: { open: boolean; initial: Monitor | null; autoBidAllowed: boolean; autoTradeAllowed: boolean; onClose: () => void }) {
  return (
    <Drawer open={open} onClose={onClose} title={initial ? `Edit ${initial.name}` : 'New monitor'} width={500}>
      {/* mounted per opening: the form starts from the monitor (or a blank one) every time */}
      {open && <MonitorForm key={initial?.id ?? 'new'} initial={initial} autoBidAllowed={autoBidAllowed} autoTradeAllowed={autoTradeAllowed} onClose={onClose} />}
    </Drawer>
  );
}

function MonitorForm({ initial, autoBidAllowed, autoTradeAllowed, onClose }: { initial: Monitor | null; autoBidAllowed: boolean; autoTradeAllowed: boolean; onClose: () => void }) {
  const m = useMonitorMutations();
  const toast = useToast();
  const packs = usePacks();
  const [form, setForm] = useState<MonitorInput>(() =>
    initial
      ? ({
          kind: initial.kind,
          name: initial.name,
          enabled: initial.enabled,
          intervalSec: initial.intervalSec,
          params:
            initial.kind === 'auctions'
              ? { ...initial.params, autoBid: { ...initial.params.autoBid, copies: initial.params.autoBid.copies ?? 1 } }
              : initial.kind === 'trades'
                ? { ...TRADE_BLANK, ...initial.params }
                : initial.params,
        } as MonitorInput)
      : blank('auctions'),
  );
  const [error, setError] = useState<string | null>(null);

  const floor = FLOOR[form.kind];
  const save = () => {
    if (form.intervalSec < floor) return setError(`Check at most every ${floor} seconds for this kind of monitor.`);
    if (form.kind === 'auctions' && form.params.autoBid.enabled && !form.params.maxPrice) return setError('Automatic bidding needs a maximum price.');
    const done = { onSuccess: () => (toast({ kind: 'success', title: initial ? 'Monitor saved' : 'Monitor created' }), onClose()), onError: (e: unknown) => setError(explain(e)) };
    if (initial) m.update.mutate({ id: initial.id, m: form }, done);
    else m.create.mutate(form, done);
  };
  const numIn = (v: string) => (v === '' ? undefined : Math.max(0, Math.floor(Number(v.replace(/\D/g, '')) || 0)));

  return (
      <form
        className="flex flex-col gap-5 p-5"
        onSubmit={(e) => {
          e.preventDefault();
          save();
        }}
      >
        {!initial && (
          <Segmented<MonitorKind>
            label="Monitor kind"
            layoutId="mon-kind"
            value={form.kind}
            onChange={(k) => setForm(blank(k))}
            options={[
              { value: 'auctions', label: 'Market listings' },
              { value: 'trades', label: 'Chat trades' },
              { value: 'account', label: 'My account' },
            ]}
          />
        )}
        <Field label="Name" htmlFor="mon-name">
          <input id="mon-name" value={form.name} maxLength={60} onChange={(e) => setForm({ ...form, name: e.target.value })} className={inputClass} required />
        </Field>
        <Field label="Check every (seconds)" htmlFor="mon-int" hint={`At least ${floor} seconds, to stay gentle with Kyara.`}>
          <input id="mon-int" inputMode="numeric" value={form.intervalSec} onChange={(e) => setForm({ ...form, intervalSec: numIn(e.target.value) ?? 0 })} className={cx(inputClass, 'num')} />
        </Field>

        {form.kind === 'auctions' ? (
          <>
            <fieldset className="grid grid-cols-2 gap-4">
              <legend className="mb-2 text-sm font-bold">What to watch</legend>
              <Field label="Character name" htmlFor="mon-q">
                <input id="mon-q" value={form.params.q ?? ''} onChange={(e) => setForm({ ...form, params: { ...form.params, q: e.target.value || undefined } })} className={inputClass} />
              </Field>
              <Field label="Character ID" htmlFor="mon-cid">
                <input id="mon-cid" inputMode="numeric" value={form.params.characterId ?? ''} onChange={(e) => setForm({ ...form, params: { ...form.params, characterId: numIn(e.target.value) || undefined } })} className={cx(inputClass, 'num')} />
              </Field>
              <Field label="Rarity" htmlFor="mon-r">
                <select id="mon-r" value={form.params.rarity ?? ''} onChange={(e) => setForm({ ...form, params: { ...form.params, rarity: (e.target.value || undefined) as Rarity | undefined } })} className={inputClass}>
                  <option value="">Any</option>
                  {RARITY_ORDER.map((r) => (
                    <option key={r} value={r}>
                      {RARITY[r].name}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Type" htmlFor="mon-t">
                <select id="mon-t" value={form.params.type ?? ''} onChange={(e) => setForm({ ...form, params: { ...form.params, type: (e.target.value || undefined) as 'auction' | 'fixed' | undefined } })} className={inputClass}>
                  <option value="">Auctions and fixed price</option>
                  <option value="auction">Auctions</option>
                  <option value="fixed">Fixed price</option>
                </select>
              </Field>
              <Field label="Maximum price" htmlFor="mon-max">
                <input id="mon-max" inputMode="numeric" value={form.params.maxPrice ?? ''} onChange={(e) => setForm({ ...form, params: { ...form.params, maxPrice: numIn(e.target.value) || undefined } })} className={cx(inputClass, 'num')} />
              </Field>
              <Field label="Warn when ending within (min)" htmlFor="mon-end">
                <input id="mon-end" inputMode="numeric" value={Math.round(form.params.endingSoonSec / 60)} onChange={(e) => setForm({ ...form, params: { ...form.params, endingSoonSec: (numIn(e.target.value) ?? 0) * 60 } })} className={cx(inputClass, 'num')} />
              </Field>
            </fieldset>

            <AutoBidFields form={form} setForm={setForm} autoBidAllowed={autoBidAllowed} numIn={numIn} />
          </>
        ) : form.kind === 'trades' ? (
          <TradeFields form={form} setForm={setForm} autoTradeAllowed={autoTradeAllowed} numIn={numIn} />
        ) : (
          <fieldset className="flex flex-col gap-4">
            <legend className="mb-2 text-sm font-bold">Alerts and optional actions</legend>
            <p className="text-sm text-muted">Tells you when free packs are full, rewards can be claimed, or a pack becomes available at no cost.</p>
            <label className="flex items-start gap-3 text-sm">
              <input type="checkbox" className="mt-1 h-4 w-4" checked={form.params.autoClaim} onChange={(e) => setForm({ ...form, params: { ...form.params, autoClaim: e.target.checked } })} />
              <span>Claim rewards automatically (spends nothing)</span>
            </label>
            <Field label="Open this pack automatically while it is free" htmlFor="mon-free" hint="Only when it costs 0 chakra. If Kyara turns its anti-bot check on, this also needs Kyara open and in view.">
              <select id="mon-free" value={form.params.autoOpenFreePack ?? ''} onChange={(e) => setForm({ ...form, params: { ...form.params, autoOpenFreePack: e.target.value || null } })} className={inputClass}>
                <option value="">Do not open packs</option>
                {(packs.data?.packs ?? [])
                  .filter((p) => p.pack.usesFreePacks)
                  .map((p) => (
                    <option key={p.pack.id} value={p.pack.id}>
                      {p.pack.name}
                    </option>
                  ))}
              </select>
            </Field>
          </fieldset>
        )}

        {error && (
          <p role="alert" className="text-sm text-bad">
            {error}
          </p>
        )}
        <div className="flex justify-end gap-2 border-t border-line pt-4">
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" busy={m.create.isPending || m.update.isPending}>
            {initial ? 'Save monitor' : 'Create monitor'}
          </Button>
        </div>
      </form>
  );
}

type AuctionForm = Extract<MonitorInput, { kind: 'auctions' }>;

function AutoBidFields({ form, setForm, autoBidAllowed, numIn }: { form: AuctionForm; setForm: (f: MonitorInput) => void; autoBidAllowed: boolean; numIn: (v: string) => number | undefined }) {
  const ab = form.params.autoBid;
  const set = (patch: Partial<AuctionForm['params']['autoBid']>) => setForm({ ...form, params: { ...form.params, autoBid: { ...ab, ...patch } } });
  const max = ab.maxBid ? Math.min(ab.maxBid, form.params.maxPrice ?? Infinity) : form.params.maxPrice;
  const budget = ab.budget || (max ? ab.copies * max : 0);
  return (
    <fieldset className={cx('rounded-[var(--radius-panel)] border p-4', ab.enabled ? 'border-warn/50 bg-warn/5' : 'border-line')}>
      <legend className="px-1 text-sm font-bold">Automatic bidding (spends chakra)</legend>
      <label className="flex items-start gap-3 text-sm">
        <input type="checkbox" className="mt-1 h-4 w-4 accent-[var(--color-warn)]" checked={ab.enabled} disabled={!autoBidAllowed && !ab.enabled} onChange={(e) => set({ enabled: e.target.checked })} />
        <span>
          Bid on matching auctions near their end, until I have enough copies.
          {!autoBidAllowed && (
            <span className="mt-2 block text-xs text-muted">
              Automatic bidding is off for this bot. Turn it on and set its budget in{' '}
              <Link to="/settings" className="text-focus underline-offset-4 hover:underline">
                Settings
              </Link>
              .
            </span>
          )}
        </span>
      </label>
      {ab.enabled && (
        <div className="mt-4 grid grid-cols-3 gap-3">
          <Field label="Copies to get" htmlFor="ab-c">
            <input id="ab-c" inputMode="numeric" value={ab.copies} onChange={(e) => set({ copies: Math.min(50, Math.max(1, numIn(e.target.value) ?? 1)) })} className={cx(inputClass, 'num')} />
          </Field>
          <Field label="Total budget" htmlFor="ab-b">
            <input id="ab-b" inputMode="numeric" placeholder={budget ? String(budget) : 'Auto'} value={ab.budget || ''} onChange={(e) => set({ budget: numIn(e.target.value) ?? 0 })} className={cx(inputClass, 'num')} />
          </Field>
          <Field label="Bid in the last (s)" htmlFor="ab-w">
            <input id="ab-w" inputMode="numeric" value={ab.withinSec} onChange={(e) => set({ withinSec: numIn(e.target.value) ?? 0 })} className={cx(inputClass, 'num')} />
          </Field>
          <p className="col-span-3 text-sm text-washi-dim">
            {max
              ? `Gets up to ${ab.copies} cop${ab.copies === 1 ? 'y' : 'ies'}, paying at most ${num(max)} chakra each and ${num(budget)} in total.`
              : 'Set a maximum price above: it is the most you pay per copy.'}
          </p>
          <p className="col-span-3 text-xs text-muted">
            Kyara bids are maximums: the bot sends your maximum price once, and Kyara raises your bid only as far as someone else pushes it. You pay the winning price, not your maximum, and an outbid is refunded. The limits in Settings always win, and an unclear outcome stops auto-bidding.
          </p>
        </div>
      )}
    </fieldset>
  );
}

type TradeForm = Extract<MonitorInput, { kind: 'trades' }>;

function TradeFields({ form, setForm, autoTradeAllowed, numIn }: { form: TradeForm; setForm: (f: MonitorInput) => void; autoTradeAllowed: boolean; numIn: (v: string) => number | undefined }) {
  const p = form.params;
  const set = <K extends keyof TradeParams>(k: K, v: Partial<TradeParams[K]> | TradeParams[K]) =>
    setForm({ ...form, params: { ...p, [k]: typeof v === 'object' && v !== null && !Array.isArray(v) ? { ...(p[k] as object), ...v } : v } });
  const n = (v: string, min = 0) => Math.max(min, numIn(v) ?? 0);
  const check = (id: string, label: string, checked: boolean, on: (v: boolean) => void, hint?: string) => (
    <label htmlFor={id} className="flex items-start gap-3 text-sm">
      <input id={id} type="checkbox" className="mt-1 h-4 w-4" checked={checked} onChange={(e) => on(e.target.checked)} />
      <span>
        {label}
        {hint && <span className="block text-xs text-muted">{hint}</span>}
      </span>
    </label>
  );
  const numField = (id: string, label: string, value: number, on: (v: number) => void, hint?: string) => (
    <Field label={label} htmlFor={id} hint={hint}>
      <input id={id} inputMode="numeric" value={value} onChange={(e) => on(n(e.target.value))} className={cx(inputClass, 'num')} />
    </Field>
  );
  return (
    <>
      <p className="text-sm text-muted">
        Reads the market chat for cards tagged “Anyone have it?” or “Available for a trade”, and answers with a trade proposal. Only spare copies are given, only trades Kyara's fair-play check calls fair are sent, and the bot never accepts a trade for you.
      </p>

      <fieldset className={cx('rounded-[var(--radius-panel)] border p-4', p.mode === 'auto' ? 'border-warn/50 bg-warn/5' : 'border-line')}>
        <legend className="px-1 text-sm font-bold">Mode</legend>
        <Segmented<'preview' | 'auto'>
          label="Trade mode"
          layoutId="trade-mode"
          value={p.mode}
          onChange={(mode) => set('mode', mode)}
          options={[
            { value: 'preview', label: 'Preview' },
            { value: 'auto', label: 'Send trades' },
          ]}
        />
        <p className="mt-2 text-xs text-muted">
          {p.mode === 'preview'
            ? 'Preview posts “Would offer…” in Activity and sends nothing. Watch it for a while before sending.'
            : autoTradeAllowed
              ? 'Trades are sent automatically within the limits below. Cards offered stay locked by Kyara while a trade is pending.'
              : 'Sending trades is off in Settings, so this monitor will only preview.'}
        </p>
      </fieldset>

      <fieldset className="flex flex-col gap-3">
        <legend className="mb-2 text-sm font-bold">Someone is looking for a card I have spare</legend>
        {check('tr-seek', 'Offer them a spare copy', p.seek.enabled, (v) => set('seek', { enabled: v }))}
        {p.seek.enabled && (
          <div className="grid grid-cols-3 gap-3 pl-7">
            {numField('tr-wmin', 'Wishlist card, min %', p.seek.wishMinPct, (v) => set('seek', { wishMinPct: v }))}
            {numField('tr-wmax', 'max %', p.seek.wishMaxPct, (v) => set('seek', { wishMaxPct: v }))}
            {numField('tr-mark', 'Else chakra, %', p.seek.markupPct, (v) => set('seek', { markupPct: v }))}
            <div className="col-span-3">{check('tr-ask', 'Ask for chakra when none of their cards on my wishlist fits', p.seek.allowChakra, (v) => set('seek', { allowChakra: v }))}</div>
            <p className="col-span-3 text-xs text-muted">Percentages of the card's value on Kyara's fair-play scale. First choice: a card from my wishlist they can trade, worth {p.seek.wishMinPct}–{p.seek.wishMaxPct}% of mine.</p>
          </div>
        )}
      </fieldset>

      <fieldset className="flex flex-col gap-3">
        <legend className="mb-2 text-sm font-bold">Someone offers a card on my wishlist</legend>
        {check('tr-offer', 'Ask them for it', p.offer.enabled, (v) => set('offer', { enabled: v }))}
        {p.offer.enabled && (
          <div className="grid grid-cols-3 gap-3 pl-7">
            <div className="col-span-3 flex flex-col gap-2">
              {check('tr-cards', 'Pay with my spare copies (cards they do not own first)', p.offer.payWithCards, (v) => set('offer', { payWithCards: v }))}
              {check('tr-chak', 'Else pay chakra', p.offer.payWithChakra, (v) => set('offer', { payWithChakra: v }))}
              {check('tr-miss', 'Only characters I do not own yet', p.offer.onlyMissing, (v) => set('offer', { onlyMissing: v }))}
            </div>
            {numField('tr-pmin', 'Pay min %', p.offer.minPayPct, (v) => set('offer', { minPayPct: v }))}
            {numField('tr-pmax', 'Pay max %', p.offer.maxPayPct, (v) => set('offer', { maxPayPct: v }))}
            {numField('tr-pcap', 'Max chakra', p.offer.maxChakra, (v) => set('offer', { maxChakra: v }))}
          </div>
        )}
      </fieldset>

      <fieldset className="grid grid-cols-2 gap-3">
        <legend className="mb-2 text-sm font-bold">Cards I give</legend>
        {numField('tr-keep', 'Extra copies to keep', p.give.keep, (v) => set('give', { keep: Math.min(50, v) }), 'Kyara always keeps one.')}
        <Field label="Rarities I give" htmlFor="tr-rar" hint="None ticked = all.">
          <div id="tr-rar" className="flex flex-wrap gap-1.5">
            {RARITY_ORDER.map((r) => {
              const on = p.give.rarities.includes(r);
              return (
                <button
                  key={r}
                  type="button"
                  aria-pressed={on}
                  onClick={() => set('give', { rarities: on ? p.give.rarities.filter((x) => x !== r) : [...p.give.rarities, r] as Rarity[] })}
                  className={cx('h-8 min-w-8 rounded-[var(--radius-chip)] border px-2 text-xs', on ? 'border-washi bg-ink-3 text-washi' : 'border-line text-muted')}
                  style={on ? { borderColor: RARITY[r].color, color: RARITY[r].color } : undefined}
                >
                  {RARITY[r].name}
                </button>
              );
            })}
          </div>
        </Field>
      </fieldset>

      <fieldset className="grid grid-cols-3 gap-3">
        <legend className="mb-2 text-sm font-bold">Limits</legend>
        {numField('tr-pend', 'Pending at once', p.limits.maxPending, (v) => set('limits', { maxPending: Math.min(20, Math.max(1, v)) }))}
        {numField('tr-hour', 'Per hour', p.limits.maxPerHour, (v) => set('limits', { maxPerHour: Math.min(60, Math.max(1, v)) }))}
        {numField('tr-exp', 'Cancel after (min)', p.limits.expireMin, (v) => set('limits', { expireMin: v }))}
        {numField('tr-user', 'Once per player (h)', p.limits.perUserHours, (v) => set('limits', { perUserHours: Math.max(1, v) }))}
        {numField('tr-bud', 'Chakra budget', p.limits.budget, (v) => set('limits', { budget: v }), '0 = cards only')}
        {numField('tr-age', 'Requests up to (min) old', p.maxAgeMin, (v) => set('maxAgeMin', Math.min(120, Math.max(1, v))))}
        <p className="col-span-3 text-xs text-muted">Unanswered trades are cancelled after {p.limits.expireMin} min so the cards can be sold or offered again (Kyara would keep them locked for 48 h).</p>
      </fieldset>

      <Field label="Message sent with the trade" htmlFor="tr-msg" hint="{pseudo} and {name} are replaced. Leave empty to send none. The bot never writes in the chat.">
        <input id="tr-msg" value={p.message} maxLength={200} onChange={(e) => set('message', e.target.value)} className={inputClass} />
      </Field>
    </>
  );
}
