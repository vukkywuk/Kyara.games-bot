import { AnimatePresence, motion } from 'motion/react';
import { useMemo, useState } from 'react';
import { ArrowLeftRight, Bot, ExternalLink, X } from 'lucide-react';
import { CharacterArt } from '../components/character';
import { ConfirmDialog, useToast } from '../components/overlay';
import { Button, EmptyState, ErrorState, PageHeader, Segmented, Skeleton, StatusDot, cx } from '../components/ui';
import { explain } from '../lib/api';
import { ago, duration, num } from '../lib/format';
import { useCancelTrade, useCharacters, useNow, useTrades } from '../lib/queries';
import type { Character, Trade, TradeSide } from '../lib/types';

type Tab = 'outgoing' | 'incoming';

const STATUS: Record<string, { label: string; tone: 'live' | 'ok' | 'idle' | 'warn' | 'bad' }> = {
  pending: { label: 'Pending', tone: 'live' },
  accepted: { label: 'Accepted', tone: 'ok' },
  declined: { label: 'Declined', tone: 'bad' },
  cancelled: { label: 'Cancelled', tone: 'idle' },
  expired: { label: 'Expired', tone: 'idle' },
};

export function TradesPage() {
  const [tab, setTab] = useState<Tab>('outgoing');
  const trades = useTrades();
  const chars = useCharacters();
  const byId = useMemo(() => new Map((chars.data ?? []).map((c) => [c.id, c])), [chars.data]);
  const [cancelling, setCancelling] = useState<Trade | null>(null);
  const cancel = useCancelTrade();
  const toast = useToast();
  const bot = new Set(trades.data?.botTradeIds ?? []);
  const list = trades.data?.[tab] ?? [];
  const pendingOut = trades.data?.outgoing.filter((t) => t.status === 'pending').length ?? 0;
  const pendingIn = trades.data?.incoming.filter((t) => t.status === 'pending').length ?? 0;

  return (
    <>
      <PageHeader
        title="Trades"
        description="Trades you proposed (by hand or by a trade monitor) and the ones you received. Cards in a pending trade stay locked by Kyara."
        actions={
          <Segmented<Tab>
            label="Trade direction"
            layoutId="trade-tab"
            value={tab}
            onChange={setTab}
            options={[
              { value: 'outgoing', label: 'Sent', count: pendingOut || undefined },
              { value: 'incoming', label: 'Received', count: pendingIn || undefined },
            ]}
          />
        }
      />
      {trades.isError ? (
        <ErrorState message={explain(trades.error)} onRetry={() => void trades.refetch()} />
      ) : !trades.data ? (
        <Skeleton className="h-64" />
      ) : list.length === 0 ? (
        <EmptyState icon={ArrowLeftRight} title={tab === 'outgoing' ? 'No trade sent yet' : 'No trade received yet'}>
          {tab === 'outgoing' ? 'Create a “Chat trades” monitor to answer trade requests from the market chat.' : 'Trades other players send you show up here.'}
        </EmptyState>
      ) : (
        <ul className="flex flex-col gap-2">
          <AnimatePresence initial={false}>
            {list.map((t) => (
              <motion.li key={t.id} layout initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} transition={{ duration: 0.18 }}>
                <TradeRow trade={t} dir={tab} byBot={bot.has(t.id)} byId={byId} onCancel={() => setCancelling(t)} />
              </motion.li>
            ))}
          </AnimatePresence>
        </ul>
      )}
      <ConfirmDialog
        open={!!cancelling}
        title="Cancel this trade?"
        summary={cancelling ? `Your proposal to ${cancelling.to.pseudo} is withdrawn and the cards you offered are unlocked.` : null}
        cost={null}
        confirmLabel="Cancel trade"
        busy={cancel.isPending}
        onClose={() => setCancelling(null)}
        onConfirm={() =>
          cancelling &&
          cancel.mutate(cancelling.id, {
            onSuccess: () => (toast({ kind: 'success', title: 'Trade cancelled' }), setCancelling(null)),
            onError: (e) => toast({ kind: 'error', title: 'Could not cancel', detail: explain(e) }),
          })
        }
      />
    </>
  );
}

function TradeRow({ trade: t, dir, byBot, byId, onCancel }: { trade: Trade; dir: Tab; byBot: boolean; byId: Map<number, Character>; onCancel: () => void }) {
  const now = useNow(30_000);
  const st = STATUS[t.status] ?? { label: t.status, tone: 'idle' as const };
  const other = dir === 'outgoing' ? t.to : t.from;
  const left = t.expiresAt ? Date.parse(t.expiresAt) - now : null;
  return (
    <div className="rounded-[var(--radius-panel)] bg-ink-1 p-4">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <p className="min-w-0 flex-1 font-bold">
          {dir === 'outgoing' ? 'To' : 'From'} {other.pseudo}
          {byBot && (
            <span className="ml-2 inline-flex items-center gap-1 rounded-[var(--radius-chip)] bg-ink-3 px-1.5 align-middle text-xs font-normal text-washi-dim">
              <Bot size={12} aria-hidden /> Sent by a monitor
            </span>
          )}
        </p>
        <span className="flex items-center gap-2 text-sm">
          <StatusDot tone={st.tone} />
          {st.label}
        </span>
        <span className="text-xs text-muted">
          {ago(t.createdAt, now)}
          {t.status === 'pending' && left !== null && left > 0 ? `, expires in ${duration(left)}` : ''}
        </span>
        {t.status === 'pending' &&
          (dir === 'outgoing' ? (
            <Button size="sm" variant="ghost" icon={X} onClick={onCancel}>
              Cancel
            </Button>
          ) : (
            <a href="https://kyara.games/marche" target="_blank" rel="noreferrer" className="inline-flex items-center gap-1.5 text-sm text-focus underline-offset-4 hover:underline">
              Answer on Kyara <ExternalLink size={13} aria-hidden />
            </a>
          ))}
      </div>
      <div className="mt-3 grid items-center gap-3 sm:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)]">
        <Side label={dir === 'outgoing' ? 'You give' : 'They give'} side={t.give} byId={byId} />
        <ArrowLeftRight size={16} aria-hidden className="mx-auto hidden text-faint sm:block" />
        <Side label={dir === 'outgoing' ? 'You get' : 'They want'} side={t.want} byId={byId} />
      </div>
      {t.message && <p className="mt-3 border-t border-line pt-2 text-sm text-washi-dim">“{t.message}”</p>}
    </div>
  );
}

function Side({ label, side, byId }: { label: string; side: TradeSide; byId: Map<number, Character> }) {
  return (
    <div className="min-w-0">
      <p className="mb-1.5 text-xs text-muted">{label}</p>
      <div className="flex flex-wrap items-center gap-2">
        {side.cards.map((c) => {
          const ch = byId.get(c.characterId);
          return (
            <span key={c.characterId} className="flex min-w-0 items-center gap-2 rounded-[var(--radius-ctl)] bg-ink-2 py-1 pl-1 pr-2.5">
              {ch ? <CharacterArt character={ch} className="w-7 shrink-0" sizes="28px" /> : <span className="h-10 w-7 shrink-0 rounded bg-ink-3" aria-hidden />}
              <span className={cx('truncate text-sm', !ch && 'text-muted')}>
                {c.qty > 1 && <span className="num">{c.qty}× </span>}
                {ch?.name ?? `#${c.characterId}`}
              </span>
            </span>
          );
        })}
        {side.chakra > 0 && <span className="num rounded-[var(--radius-ctl)] bg-ink-2 px-2.5 py-2 text-sm">{num(side.chakra)} chakra</span>}
        {!side.cards.length && !side.chakra && <span className="text-sm text-faint">Nothing</span>}
      </div>
    </div>
  );
}
