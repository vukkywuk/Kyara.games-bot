import { Link } from 'react-router';
import { Check, CircleDashed, PlugZap, Sparkles } from 'lucide-react';
import { useToast } from '../components/overlay';
import { Button, EmptyState, ErrorState, Meter, PageHeader, Panel, Skeleton, cx } from '../components/ui';
import { explain } from '../lib/api';
import { describeGain, duration } from '../lib/format';
import { useClaim, useNow, useProgress, useStatus } from '../lib/queries';
import { listClaimables } from '../../../src/modules/progressView';
import type { Progress } from '../lib/types';

type Mission = NonNullable<Progress['daily']>['missions'][number];

export function MissionsPage() {
  const status = useStatus();
  const loggedIn = !!status.data?.session.hasToken;
  const p = useProgress(loggedIn);
  const claim = useClaim();
  const toast = useToast();
  const now = useNow(30_000);

  const doClaim = (kind: string, id?: string) =>
    claim.mutate(
      { kind, id },
      {
        onSuccess: (r) => r.status === 'succeeded' && toast({ kind: 'success', title: 'Claimed', detail: describeGain(r.result.gained) }),
        onError: (e) => toast({ kind: 'error', title: 'Could not claim', detail: explain(e) }),
      },
    );

  if (status.data && !loggedIn)
    return (
      <>
        <PageHeader title="Missions" />
        <EmptyState icon={PlugZap} title="Connect your account to see your missions" action={<Link to="/session" className="text-focus underline underline-offset-4">Set up the session</Link>} />
      </>
    );

  const data = p.data;
  const claimables = data ? listClaimables(data) : [];
  return (
    <>
      <PageHeader
        title="Missions"
        description={data?.resets.nextDaily ? `Daily missions reset in ${duration(Date.parse(data.resets.nextDaily) - now)}.` : 'Daily and weekly missions, streak and achievements.'}
        actions={
          <Button variant="primary" icon={Sparkles} disabled={!data || data.claimable === 0} busy={claim.isPending} onClick={() => doClaim('all')}>
            Claim all{data?.claimable ? ` (${data.claimable})` : ''}
          </Button>
        }
      />
      {p.isError && <ErrorState message={explain(p.error)} onRetry={() => void p.refetch()} />}
      {!data ? (
        <div className="grid gap-4 lg:grid-cols-2">
          <Skeleton className="h-56" />
          <Skeleton className="h-56" />
        </div>
      ) : (
        <div className="grid items-start gap-4 lg:grid-cols-2">
          {(['daily', 'weekly'] as const).map((k) => {
            const block = data[k];
            if (!block) return null;
            return (
              <Panel key={k} title={k === 'daily' ? 'Daily missions' : 'Weekly missions'} action={block.bonusClaimed ? <span className="text-sm text-ok">Bonus claimed</span> : undefined}>
                <ul className="flex flex-col gap-3">
                  {block.missions.map((m, i) => (
                    <MissionRow key={m.id ?? i} m={m} />
                  ))}
                </ul>
              </Panel>
            );
          })}
          {data.streak && (
            <Panel title="Login streak">
              <p className="font-display text-2xl font-bold">Day {data.streak.day ?? '–'}</p>
              <p className="text-sm text-muted">{data.streak.claimedToday ? 'Claimed today. Come back tomorrow.' : 'Today’s streak reward is waiting.'}</p>
              {!data.streak.claimedToday && (
                <Button className="mt-3" size="sm" icon={Sparkles} onClick={() => doClaim('streak')} busy={claim.isPending}>
                  Claim streak
                </Button>
              )}
            </Panel>
          )}
          <Panel title={`Achievements (${data.achievements.filter((a) => a.claimed).length}/${data.achievements.length})`} className={cx(!data.streak && 'lg:col-span-2')}>
            {claimables.filter((c) => c.kind !== 'streak').length > 0 && (
              <ul className="mb-4 flex flex-col gap-2">
                {claimables
                  .filter((c) => c.kind !== 'streak')
                  .map((c) => (
                    <li key={`${c.kind}-${c.id}`} className="flex items-center justify-between gap-3 rounded-[var(--radius-ctl)] bg-ink-2 px-3 py-2 text-sm">
                      <span>{c.label}</span>
                      <Button size="sm" onClick={() => doClaim(c.kind, c.id)} busy={claim.isPending}>
                        Claim
                      </Button>
                    </li>
                  ))}
              </ul>
            )}
            <ul className="grid gap-x-6 gap-y-3 md:grid-cols-2">
              {data.achievements.map((a, i) => (
                <MissionRow key={a.id ?? i} m={a} />
              ))}
            </ul>
          </Panel>
        </div>
      )}
    </>
  );
}

function MissionRow({ m }: { m: Mission }) {
  const done = !!m.done || !!m.claimed;
  return (
    <li className="flex items-start gap-3 text-sm">
      {done ? <Check size={16} className="mt-0.5 shrink-0 text-ok" aria-label="Done" /> : <CircleDashed size={16} className="mt-0.5 shrink-0 text-faint" aria-label="In progress" />}
      <div className="min-w-0 flex-1">
        <div className="flex justify-between gap-3">
          <span className={cx(done ? 'text-washi-dim' : 'text-washi')}>{m.label ?? m.description ?? m.id}</span>
          {m.target !== undefined && (
            <span className="num shrink-0 text-muted">
              {Math.min(m.progress ?? 0, m.target)}/{m.target}
            </span>
          )}
        </div>
        {m.target !== undefined && m.target > 1 && !done && (
          <div className="mt-1.5">
            <Meter value={m.progress ?? 0} max={m.target} label={`${m.label ?? 'Mission'} progress`} />
          </div>
        )}
      </div>
    </li>
  );
}
