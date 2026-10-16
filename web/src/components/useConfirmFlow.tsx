import { useCallback, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { ApiError, explain } from '../lib/api';
import type { ActionResponse } from '../lib/types';
import { ConfirmDialog, useToast } from './overlay';

type Mode = 'dryRun' | 'confirm';

/**
 * Two-step action flow shared by bids, purchases and pack openings:
 *   1. dry run on the server (same checks as the real call) -> exact summary and cost;
 *   2. the user confirms -> one guarded call. No retry on an uncertain outcome.
 */
export function useConfirmFlow<V, R>(opts: {
  run: (v: V & { mode: Mode }) => Promise<ActionResponse<R>>;
  title: string;
  confirmLabel: string;
  onSuccess: (result: R, vars: V) => void;
  /** Skip the dialog when the dry run says it costs nothing (e.g. a free pack: the click is the intent). */
  skipWhenFree?: boolean;
}) {
  const toast = useToast();
  const navigate = useNavigate();
  const [state, setState] = useState<{ vars: V; summary: string | null; cost: number | null } | null>(null);
  const [busy, setBusy] = useState(false);
  const [checking, setChecking] = useState(false);
  const inFlight = useRef(false);

  const fail = useCallback(
    (e: unknown) => {
      if (e instanceof ApiError && e.code === 'ambiguous') {
        toast({ kind: 'warn', title: 'Outcome unknown: not retried', detail: 'Kyara did not confirm in time. Check your account, then resolve it in Activity.' });
        navigate('/activity');
      } else toast({ kind: 'error', title: 'Not done', detail: explain(e) });
    },
    [toast, navigate],
  );

  const execute = useCallback(
    async (vars: V) => {
      if (inFlight.current) return;
      inFlight.current = true;
      setBusy(true);
      try {
        const res = await opts.run({ ...vars, mode: 'confirm' });
        setState(null);
        if (res.status === 'succeeded') opts.onSuccess(res.result, vars);
        else toast({ kind: 'warn', title: 'Not confirmed by the bot', detail: 'Check Activity before trying again.' });
      } catch (e) {
        setState(null);
        fail(e);
      } finally {
        inFlight.current = false;
        setBusy(false);
      }
    },
    [opts, fail, toast],
  );

  const request = useCallback(
    async (vars: V) => {
      if (inFlight.current || checking) return;
      setChecking(true);
      try {
        const dry = await opts.run({ ...vars, mode: 'dryRun' });
        if (dry.status !== 'dry-run') return;
        if (opts.skipWhenFree && dry.cost === 0) {
          await execute(vars);
          return;
        }
        setState({ vars, summary: dry.summary, cost: dry.cost });
      } catch (e) {
        fail(e);
      } finally {
        setChecking(false);
      }
    },
    [opts, execute, fail, checking],
  );

  const dialog = (
    <ConfirmDialog
      open={!!state}
      title={opts.title}
      summary={state?.summary ?? null}
      cost={state?.cost ?? null}
      confirmLabel={opts.confirmLabel}
      busy={busy}
      onClose={() => !busy && setState(null)}
      onConfirm={() => state && state.summary !== null && void execute(state.vars)}
    />
  );
  return { request, dialog, busy: busy || checking };
}
