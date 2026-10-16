import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { Check, ExternalLink, KeyRound } from 'lucide-react';
import { useToast } from '../components/overlay';
import { Button, PageHeader, Panel, StatusDot, cx } from '../components/ui';
import { explain } from '../lib/api';
import { desktop } from '../lib/desktop';
import { useMonitorMutations, useMonitors, usePacks, useStatus } from '../lib/queries';
import type { MonitorInput } from '../lib/types';

export const SETUP_SEEN = 'kyara.setupSeen';

/** First run: connect the account, pick what runs, see where spending is controlled. */
export function SetupPage() {
  const status = useStatus();
  const monitors = useMonitors();
  const packs = usePacks();
  const m = useMonitorMutations();
  const toast = useToast();
  const navigate = useNavigate();
  const s = status.data?.session;
  const connected = !!s?.hasToken;
  const freePack = packs.data?.packs.find((p) => p.pack.usesFreePacks)?.pack;
  const has = (kind: string) => !!monitors.data?.monitors.some((x) => x.kind === kind);
  const [chores, setChores] = useState(true);
  const [trades, setTrades] = useState(true);
  const [busy, setBusy] = useState(false);
  const [autoStart, setAutoStart] = useState<boolean | null>(null);

  useEffect(() => {
    try {
      localStorage.setItem(SETUP_SEEN, '1');
    } catch {
      // storage may be unavailable; the wizard then simply shows again
    }
    void desktop?.getAutoStart().then(setAutoStart);
  }, []);

  const create = async () => {
    const todo: MonitorInput[] = [];
    if (chores && !has('account'))
      todo.push({ kind: 'account', name: 'Account watch', enabled: true, intervalSec: 300, params: { autoClaim: true, autoOpenFreePack: freePack?.id ?? null } });
    if (trades && !has('trades'))
      todo.push({
        kind: 'trades',
        name: 'Chat trades',
        enabled: true,
        intervalSec: 90,
        params: {
          mode: 'preview',
          rooms: null,
          maxAgeMin: 10,
          message: 'Hi {pseudo}! Saw your {name} in the market chat.',
          give: { keep: 0, rarities: [], exclude: [] },
          seek: { enabled: true, wishMinPct: 80, wishMaxPct: 130, allowChakra: true, markupPct: 110 },
          offer: { enabled: true, payWithCards: true, payWithChakra: true, minPayPct: 80, maxPayPct: 110, maxChakra: 200, maxCards: 3, onlyMissing: true },
          limits: { maxPending: 3, maxPerHour: 5, perUserHours: 24, expireMin: 30, budget: 0 },
        },
      });
    setBusy(true);
    try {
      for (const t of todo) await m.create.mutateAsync(t);
      toast({ kind: 'success', title: todo.length ? 'Monitors created' : 'All set', detail: todo.length ? 'They run in the background while the app is open (or in the tray).' : undefined });
      navigate('/');
    } catch (e) {
      toast({ kind: 'error', title: 'Could not create the monitors', detail: explain(e) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <PageHeader title="Set up Kyara Bot" description="Three steps. You can change everything later." />
      <ol className="grid max-w-[760px] gap-4">
        <Step n={1} done={connected} title="Connect your Kyara account">
          {connected ? (
            <p className="flex items-center gap-2 text-sm">
              <StatusDot tone="ok" /> Connected as <span className="font-bold">{s?.user?.pseudo ?? 'you'}</span>.
            </p>
          ) : desktop ? (
            <>
              <p className="text-sm text-muted">Log in on Kyara as usual, in the app’s own Kyara window. The bot picks up your session by itself within a few seconds.</p>
              <Button className="mt-3" variant="primary" icon={ExternalLink} onClick={() => void desktop?.openKyara()}>
                Open Kyara and log in
              </Button>
            </>
          ) : (
            <>
              <p className="text-sm text-muted">Pair the Kyara Bridge browser extension: the bot then follows the kyara.games tab you are logged in with.</p>
              <Link to="/session" className="mt-3 inline-flex h-10 items-center gap-2 rounded-[var(--radius-ctl)] bg-washi px-4 font-bold text-ink-0 hover:bg-washi-hi">
                <KeyRound size={16} aria-hidden /> Pair the extension
              </Link>
            </>
          )}
          <p className="mt-3 text-xs text-faint">Opening packs needs Kyara’s anti-bot pass, which Kyara only renews while its page is open and visible. Claims, bids and trades work without it.</p>
        </Step>

        <Step n={2} done={has('account') && has('trades')} title="Choose what runs">
          <div className="flex flex-col gap-3 text-sm">
            <label className="flex items-start gap-3">
              <input type="checkbox" className="mt-1 h-4 w-4" checked={chores || has('account')} disabled={has('account')} onChange={(e) => setChores(e.target.checked)} />
              <span>
                <span className="font-bold">Daily chores</span>
                <span className="block text-muted">Claims rewards and opens {freePack ? freePack.name : 'the free pack'} whenever it costs nothing. {has('account') && 'Already set up.'}</span>
              </span>
            </label>
            <label className="flex items-start gap-3">
              <input type="checkbox" className="mt-1 h-4 w-4" checked={trades || has('trades')} disabled={has('trades')} onChange={(e) => setTrades(e.target.checked)} />
              <span>
                <span className="font-bold">Chat trades, in preview</span>
                <span className="block text-muted">Shows which trade it would send when someone in the market chat looks for your spare cards or offers one on your wishlist. Nothing is sent until you switch it on. {has('trades') && 'Already set up.'}</span>
              </span>
            </label>
            <p className="text-xs text-faint">
              Auction monitors need a character and a price: add them from{' '}
              <Link to="/automation" className="text-focus underline-offset-4 hover:underline">
                Monitors
              </Link>
              .
            </p>
          </div>
        </Step>

        <Step n={3} title="Spending stays off until you allow it">
          <p className="text-sm text-muted">
            Bids and trades never spend chakra or cards until you turn them on in{' '}
            <Link to="/settings" className="text-focus underline-offset-4 hover:underline">
              Settings
            </Link>
            , with your own budget. Free packs and reward claims cost nothing.
          </p>
          {desktop && autoStart !== null && (
            <label className="mt-3 flex items-center gap-3 text-sm">
              <input type="checkbox" className="h-4 w-4" checked={autoStart} onChange={(e) => void desktop?.setAutoStart(e.target.checked).then(setAutoStart)} />
              Start Kyara Bot with Windows (in the tray)
            </label>
          )}
        </Step>
      </ol>
      <div className="mt-5 flex max-w-[760px] justify-end gap-2">
        <Button variant="ghost" onClick={() => navigate('/')}>
          Skip
        </Button>
        <Button variant="primary" busy={busy} disabled={!monitors.data || !packs.data} onClick={() => void create()}>
          Finish
        </Button>
      </div>
    </>
  );
}

function Step({ n, title, done, children }: { n: number; title: string; done?: boolean; children: React.ReactNode }) {
  return (
    <li>
      <Panel>
        <div className="flex gap-4">
          <span
            aria-hidden
            className={cx('grid h-8 w-8 shrink-0 place-items-center rounded-full border font-display text-sm font-bold', done ? 'border-ok bg-ok/15 text-ok' : 'border-line text-washi-dim')}
          >
            {done ? <Check size={16} /> : n}
          </span>
          <div className="min-w-0 flex-1">
            <h2 className="mb-2 font-bold">
              {title}
              {done && <span className="sr-only"> (done)</span>}
            </h2>
            {children}
          </div>
        </div>
      </Panel>
    </li>
  );
}
