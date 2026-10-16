import { AnimatePresence, motion } from 'motion/react';
import { useState } from 'react';
import { KeyRound, Link2Off, PlugZap, RefreshCw, ShieldCheck } from 'lucide-react';
import { ConfirmDialog, useToast } from '../components/overlay';
import { Button, EmptyState, ErrorState, PageHeader, Panel, Skeleton, StatusDot } from '../components/ui';
import { explain } from '../lib/api';
import { ago, duration, num } from '../lib/format';
import { useBridgeMutations, useNow, useStatus, useStreamState } from '../lib/queries';
import type { BridgeClient } from '../lib/types';
import { desktop } from '../lib/desktop';

const SOURCE: Record<string, string> = {
  bridge: 'Browser extension',
  app: 'The app’s Kyara window',
  manual: 'Imported token',
  browser: 'Bot browser login',
  env: 'KYARA_TOKEN in .env',
  none: 'None',
};

export function SessionPage() {
  const status = useStatus();
  const stream = useStreamState();
  const now = useNow(1000);
  const m = useBridgeMutations();
  const toast = useToast();
  const [code, setCode] = useState<{ code: string; expiresAt: number } | null>(null);
  const [revoking, setRevoking] = useState<BridgeClient | null>(null);
  const [forgetting, setForgetting] = useState(false);

  const s = status.data;
  const codeLeft = code ? code.expiresAt - now : 0;
  const activeCode = code && codeLeft > 0 ? code : null;
  // the code disappears from screen as soon as an extension pairs with it
  const pairedSinceCode = activeCode && !s?.bridge.pairing;

  return (
    <>
      <PageHeader title="Session & bridge" description="How the bot is connected to your Kyara account. Credentials are never shown here." />
      {status.isError && <ErrorState message={explain(status.error)} onRetry={() => void status.refetch()} />}

      <div className="grid gap-4 lg:grid-cols-2">
        {desktop && (
          <Panel title="Kyara window" className="lg:col-span-2">
            <div className="flex flex-wrap items-center gap-4">
              <p className="min-w-0 flex-1 text-sm text-muted">
                Log in on Kyara in the app’s own window, as in any browser. The bot reads your session from it, and while that window is open and in view it also receives Kyara’s pack pass, so free packs get opened.
              </p>
              <Button variant="primary" onClick={() => void desktop?.openKyara()}>
                Open Kyara
              </Button>
            </div>
          </Panel>
        )}
        <Panel
          title="Kyara session"
          action={
            <Button
              size="sm"
              icon={ShieldCheck}
              busy={m.verify.isPending}
              disabled={!s?.session.hasToken}
              onClick={() =>
                m.verify.mutate(undefined, {
                  onSuccess: (r) => toast(r.valid ? { kind: 'success', title: 'Kyara accepted the session', detail: r.user ? `Logged in as ${r.user.pseudo ?? 'you'}` : undefined } : { kind: 'error', title: 'Kyara rejected the session', detail: r.problem ?? undefined }),
                  onError: (e) => toast({ kind: 'error', title: 'Could not check the session', detail: explain(e) }),
                })
              }
            >
              Check with Kyara
            </Button>
          }
        >
          {!s ? (
            <Skeleton className="h-28" />
          ) : (
            <dl className="grid grid-cols-[140px_1fr] gap-x-4 gap-y-3 text-sm">
              <dt className="text-muted">Account</dt>
              <dd className="flex items-center gap-2">
                <StatusDot tone={s.session.hasToken ? 'ok' : 'warn'} />
                {s.session.hasToken ? (
                  <span>
                    {s.session.user?.pseudo ?? 'Logged in'}
                    {s.session.user && !s.session.user.discordLinked && <span className="text-warn"> (guest account)</span>}
                  </span>
                ) : (
                  <span>No session yet</span>
                )}
              </dd>
              <dt className="text-muted">Provided by</dt>
              <dd>{SOURCE[s.session.source] ?? s.session.source}</dd>
              <dt className="text-muted">Pack pass</dt>
              <dd className="num">
                {s.session.passValidForMs ? (
                  <span className={s.session.passValidForMs < 5 * 60_000 ? 'text-warn' : ''}>Valid for {duration(s.session.passValidForMs)}</span>
                ) : (
                  <span className="text-muted">None. Needed only to open packs.</span>
                )}
              </dd>
              {s.session.savedAt && (
                <>
                  <dt className="text-muted">Updated</dt>
                  <dd>{ago(s.session.savedAt, now)}</dd>
                </>
              )}
              {s.session.problem && (
                <>
                  <dt className="text-muted">Problem</dt>
                  <dd className="text-bad">{s.session.problem}</dd>
                </>
              )}
            </dl>
          )}
          {s?.session.hasToken && (
            <div className="mt-4 border-t border-line pt-4">
              <p className="text-sm text-muted">To use another Kyara account, forget this session; the paired browser then provides the account it is logged in with.</p>
              <Button className="mt-2" size="sm" variant="ghost" onClick={() => setForgetting(true)}>
                Forget this session
              </Button>
            </div>
          )}
        </Panel>

        <Panel title="Local bot">
          {!s ? (
            <Skeleton className="h-28" />
          ) : (
            <dl className="grid grid-cols-[140px_1fr] gap-x-4 gap-y-3 text-sm">
              <dt className="text-muted">Server</dt>
              <dd className="flex items-center gap-2">
                <StatusDot tone={stream === 'open' ? 'live' : stream === 'offline' ? 'bad' : 'idle'} />
                {stream === 'open' ? 'Connected, live updates on' : stream === 'offline' ? 'Disconnected, retrying' : 'Connecting'}
              </dd>
              <dt className="text-muted">Version</dt>
              <dd>
                {s.server.version}, started {ago(s.server.startedAt, now)}
              </dd>
              <dt className="text-muted">Kyara API</dt>
              <dd className="flex items-center gap-2">
                <StatusDot tone={s.site.ok ? 'ok' : 'bad'} />
                {s.site.ok ? `Reachable, ${num(s.site.catalogSize)} characters` : (s.site.error ?? 'Unreachable')}
              </dd>
              <dt className="text-muted">Rate limit</dt>
              <dd className="num">{s.rateLimit.remaining !== null ? `${num(s.rateLimit.remaining)} of ${num(s.rateLimit.limit)} requests left in this window` : 'Not measured yet'}</dd>
            </dl>
          )}
        </Panel>

        <Panel title="Browser extension" className="lg:col-span-2" bodyClass="p-0">
          <div className="grid gap-0 lg:grid-cols-[1fr_1fr]">
            <div className="border-b border-line p-4 lg:border-b-0 lg:border-r">
              <h3 className="mb-3 text-sm font-bold text-washi-dim">Paired browsers</h3>
              {!s ? (
                <Skeleton className="h-16" />
              ) : s.bridge.clients.length === 0 ? (
                <EmptyState icon={PlugZap} title="No browser paired yet">
                  Pair the Kyara Bridge extension so the bot follows your logged-in kyara.games tab automatically.
                </EmptyState>
              ) : (
                <ul className="divide-y divide-line">
                  <AnimatePresence initial={false}>
                    {s.bridge.clients.map((c) => (
                      <motion.li key={c.id} layout initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, x: 16 }} className="flex items-center gap-3 py-3">
                        <StatusDot tone={c.lastSeenAt && now - Date.parse(c.lastSeenAt) < 15 * 60_000 ? 'ok' : 'idle'} />
                        <div className="min-w-0 flex-1">
                          <p className="font-bold">{c.label}</p>
                          <p className="text-xs text-muted">
                            Paired {ago(c.pairedAt, now)}. Last sync {ago(c.lastSyncAt, now)}.
                          </p>
                        </div>
                        <Button size="sm" variant="danger" icon={Link2Off} onClick={() => setRevoking(c)}>
                          Revoke
                        </Button>
                      </motion.li>
                    ))}
                  </AnimatePresence>
                </ul>
              )}
            </div>

            <div className="p-4">
              <h3 className="mb-3 text-sm font-bold text-washi-dim">Pair a browser</h3>
              <AnimatePresence mode="wait" initial={false}>
                {activeCode && !pairedSinceCode ? (
                  <motion.div key="code" initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -6 }} transition={{ duration: 0.2 }}>
                    <p className="text-sm text-muted">Type this code in the extension popup. It works once.</p>
                    <p className="num my-3 font-display text-3xl font-bold tracking-[0.12em] text-washi" aria-live="polite">
                      {activeCode.code}
                    </p>
                    <p className="num text-sm text-muted">Expires in {duration(codeLeft)}</p>
                    <Button className="mt-3" size="sm" variant="ghost" onClick={() => (m.cancelCode.mutate(), setCode(null))}>
                      Cancel code
                    </Button>
                  </motion.div>
                ) : (
                  <motion.div key="steps" initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -6 }} transition={{ duration: 0.2 }}>
                    <ol className="list-decimal space-y-1.5 pl-5 text-sm text-washi-dim marker:text-faint">
                      <li>
                        Build it once: <code className="rounded bg-ink-2 px-1.5 py-0.5 text-xs">npm run ext:build</code>
                      </li>
                      <li>
                        In Chrome or Edge, open <code className="rounded bg-ink-2 px-1.5 py-0.5 text-xs">chrome://extensions</code>, turn on Developer mode, choose Load unpacked and select{' '}
                        <code className="rounded bg-ink-2 px-1.5 py-0.5 text-xs">extension/dist</code>.
                      </li>
                      <li>Create a pairing code here and type it in the extension popup.</li>
                      <li>Keep kyara.games open and logged in. The bot picks up your session and pack pass by itself.</li>
                    </ol>
                    <Button
                      className="mt-4"
                      variant="primary"
                      icon={KeyRound}
                      busy={m.createCode.isPending}
                      onClick={() => m.createCode.mutate(undefined, { onSuccess: setCode, onError: (e) => toast({ kind: 'error', title: 'Could not create a code', detail: explain(e) }) })}
                    >
                      Create pairing code
                    </Button>
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          </div>
        </Panel>

        <Panel title="Without the extension" className="lg:col-span-2">
          <p className="max-w-[80ch] text-sm text-muted">
            The command line still works as a fallback. Copy the values from DevTools on kyara.games (Application, Local Storage) and paste them when asked. Input stays hidden.
          </p>
          <pre className="mt-3 overflow-x-auto rounded-[var(--radius-ctl)] bg-ink-2 p-3 text-xs leading-6 text-washi-dim">
            {`npm run dev -- session import                      # kyara_token
npm run dev -- session import-pass --device-id <kyara_device>   # kyara_pass`}
          </pre>
          <Button className="mt-3" size="sm" variant="ghost" icon={RefreshCw} onClick={() => void status.refetch()}>
            Refresh status
          </Button>
        </Panel>
      </div>

      <ConfirmDialog
        open={forgetting}
        title="Forget the bot's session?"
        summary="The bot stops using this Kyara account and all automation is paused. The session is not logged out on Kyara (your browser keeps it)."
        cost={null}
        confirmLabel="Forget session"
        busy={m.forget.isPending}
        onClose={() => setForgetting(false)}
        onConfirm={() =>
          m.forget.mutate(undefined, {
            onSuccess: () => (setForgetting(false), toast({ kind: 'success', title: 'Session forgotten', detail: 'Automation is paused. Resume it from Monitors when ready.' })),
            onError: (e) => toast({ kind: 'error', title: 'Could not forget the session', detail: explain(e) }),
          })
        }
      />
      <ConfirmDialog
        open={!!revoking}
        title="Revoke this browser?"
        summary={revoking ? `${revoking.label} will stop syncing your session. You can pair it again later with a new code.` : null}
        cost={null}
        confirmLabel="Revoke"
        busy={m.revoke.isPending}
        onClose={() => setRevoking(null)}
        onConfirm={() =>
          revoking &&
          m.revoke.mutate(revoking.id, {
            onSuccess: () => (toast({ kind: 'success', title: `${revoking.label} revoked` }), setRevoking(null)),
            onError: (e) => toast({ kind: 'error', title: 'Could not revoke', detail: explain(e) }),
          })
        }
      />
    </>
  );
}
