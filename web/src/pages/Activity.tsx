import { AnimatePresence, motion } from 'motion/react';
import { useState } from 'react';
import { ClipboardList, ScrollText, Zap } from 'lucide-react';
import { ConfirmDialog, useToast } from '../components/overlay';
import { Button, EmptyState, ErrorState, PageHeader, Panel, Segmented, Skeleton, StatusDot, cx } from '../components/ui';
import { explain } from '../lib/api';
import { ago, clock, dateTime } from '../lib/format';
import { useActions, useEvents, useLogs, useNow, useResolveAction } from '../lib/queries';
import type { ActionRecord } from '../lib/types';

type Tab = 'actions' | 'events' | 'logs';

export function ActivityPage() {
  const [tab, setTab] = useState<Tab>('actions');
  const actions = useActions();
  const unknown = (actions.data ?? []).filter((a) => a.status === 'unknown' || a.status === 'pending').length;
  return (
    <>
      <PageHeader
        title="Activity"
        description="Everything the bot did, what happened live, and its logs (secrets are always redacted)."
        actions={
          <Segmented<Tab>
            label="Activity view"
            layoutId="act-tab"
            value={tab}
            onChange={setTab}
            options={[
              { value: 'actions', label: 'Actions', count: unknown || undefined },
              { value: 'events', label: 'Events' },
              { value: 'logs', label: 'Logs' },
            ]}
          />
        }
      />
      <AnimatePresence mode="wait" initial={false}>
        <motion.div key={tab} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -4 }} transition={{ duration: 0.18 }}>
          {tab === 'actions' ? <Actions /> : tab === 'events' ? <Events /> : <Logs />}
        </motion.div>
      </AnimatePresence>
    </>
  );
}

const STATUS_LABEL = { succeeded: 'Done', failed: 'Failed', unknown: 'Unknown', pending: 'In flight' } as const;

function Actions() {
  const actions = useActions();
  const resolve = useResolveAction();
  const toast = useToast();
  const now = useNow(30_000);
  const [target, setTarget] = useState<{ a: ActionRecord; as: 'succeeded' | 'failed' } | null>(null);
  if (actions.isError) return <ErrorState message={explain(actions.error)} onRetry={() => void actions.refetch()} />;
  if (!actions.data) return <Skeleton className="h-64" />;
  if (actions.data.length === 0)
    return (
      <EmptyState icon={ClipboardList} title="No action yet">
        Pack openings, bids, purchases and claims are recorded here with their outcome.
      </EmptyState>
    );
  const unknown = actions.data.filter((a) => a.status === 'unknown' || a.status === 'pending');
  return (
    <>
      {unknown.length > 0 && (
        <div role="status" className="mb-4 rounded-[var(--radius-panel)] border border-warn/30 bg-warn/5 p-4 text-sm">
          <p className="font-bold">
            {unknown.length} action{unknown.length > 1 ? 's' : ''} with an unknown outcome
          </p>
          <p className="mt-1 text-muted">Kyara did not confirm them in time, so the bot did not retry. Check your account on Kyara, then mark each one as done or failed. Identical actions stay blocked until then.</p>
        </div>
      )}
      <Panel bodyClass="p-0">
        <ul className="divide-y divide-line">
          {actions.data.map((a) => (
            <li key={a.id} className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-start gap-4 px-4 py-3 text-sm">
              <span className="mt-1.5">
                <StatusDot tone={a.status === 'succeeded' ? 'ok' : a.status === 'failed' ? 'bad' : 'warn'} label={STATUS_LABEL[a.status]} />
              </span>
              <div className="min-w-0">
                <p className="break-words">{a.summary}</p>
                <p className="mt-0.5 text-xs text-muted">
                  {STATUS_LABEL[a.status]}
                  {a.resolvedBy === 'user' ? ' (set by you)' : ''}. {a.error && a.status !== 'succeeded' ? a.error : ''}
                </p>
                {(a.status === 'unknown' || a.status === 'pending') && (
                  <div className="mt-2 flex gap-2">
                    <Button size="sm" onClick={() => setTarget({ a, as: 'succeeded' })}>
                      It went through
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => setTarget({ a, as: 'failed' })}>
                      It did not happen
                    </Button>
                  </div>
                )}
              </div>
              <span className="whitespace-nowrap text-xs text-faint" title={dateTime(a.startedAt)}>
                {ago(a.startedAt, now)}
              </span>
            </li>
          ))}
        </ul>
      </Panel>
      <ConfirmDialog
        open={!!target}
        title={target?.as === 'succeeded' ? 'Mark as done?' : 'Mark as not done?'}
        summary={target ? `“${target.a.summary}” will be recorded as ${target.as === 'succeeded' ? 'done' : 'failed'}. Only do this after checking your account on Kyara.` : null}
        cost={null}
        confirmLabel={target?.as === 'succeeded' ? 'Mark as done' : 'Mark as failed'}
        busy={resolve.isPending}
        onClose={() => setTarget(null)}
        onConfirm={() =>
          target &&
          resolve.mutate(
            { id: target.a.id, as: target.as },
            { onSuccess: () => (setTarget(null), toast({ kind: 'success', title: 'Recorded' })), onError: (e) => toast({ kind: 'error', title: 'Could not record', detail: explain(e) }) },
          )
        }
      />
    </>
  );
}

function Events() {
  const events = useEvents();
  const now = useNow(10_000);
  if (events.isError) return <ErrorState message={explain(events.error)} onRetry={() => void events.refetch()} />;
  if (!events.data) return <Skeleton className="h-64" />;
  if (events.data.length === 0)
    return (
      <EmptyState icon={Zap} title="Nothing happened yet">
        Monitor alerts, bridge syncs and session changes appear here as they happen.
      </EmptyState>
    );
  return (
    <Panel bodyClass="p-0">
      <ul className="divide-y divide-line">
        <AnimatePresence initial={false}>
          {events.data.map((e) => (
            <motion.li key={e.id} layout="position" initial={{ opacity: 0, y: -6 }} animate={{ opacity: 1, y: 0 }} className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-start gap-4 px-4 py-3 text-sm">
              <span className="mt-1.5">
                <StatusDot tone={e.level === 'error' ? 'bad' : e.level === 'warn' ? 'warn' : e.level === 'success' ? 'ok' : 'idle'} />
              </span>
              <div className="min-w-0">
                <p>{e.title}</p>
                {e.detail && <p className="mt-0.5 break-words text-xs text-muted">{e.detail}</p>}
              </div>
              <span className="whitespace-nowrap text-xs text-faint" title={dateTime(e.at)}>
                {ago(e.at, now)}
              </span>
            </motion.li>
          ))}
        </AnimatePresence>
      </ul>
    </Panel>
  );
}

function Logs() {
  const logs = useLogs();
  if (logs.isError) return <ErrorState message={explain(logs.error)} onRetry={() => void logs.refetch()} />;
  if (!logs.data) return <Skeleton className="h-64" />;
  if (logs.data.length === 0)
    return (
      <EmptyState icon={ScrollText} title="No log line yet">
        The server writes here as it works.
      </EmptyState>
    );
  return (
    <Panel bodyClass="p-0">
      <ol className="max-h-[70vh] overflow-y-auto py-2 text-xs leading-6" aria-label="Server log, newest first">
        {logs.data.map((l) => (
          <li key={l.id} className={cx('grid grid-cols-[72px_minmax(0,1fr)] gap-3 px-4', /^(WARN|ERROR)/.test(l.line) && 'text-warn')}>
            <span className="num text-faint">{clock(l.at)}</span>
            <span className="break-words">{l.line}</span>
          </li>
        ))}
      </ol>
    </Panel>
  );
}
