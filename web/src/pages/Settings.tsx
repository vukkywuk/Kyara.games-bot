import { useEffect, useState } from 'react';
import { Lock } from 'lucide-react';
import { ConfirmDialog, useToast } from '../components/overlay';
import { Button, ErrorState, Field, PageHeader, Panel, Skeleton, cx, inputClass } from '../components/ui';
import { ApiError, explain } from '../lib/api';
import { num } from '../lib/format';
import { useSaveSettings, useSettings } from '../lib/queries';
import type { SettingField, Settings, SettingsView } from '../lib/types';
import { desktop } from '../lib/desktop';

export function SettingsPage() {
  const q = useSettings();
  return (
    <>
      <PageHeader title="Settings" description="Spending limits for everything the bot does on its own. They are off until you turn them on here." />
      {q.isError ? <ErrorState message={explain(q.error)} onRetry={() => void q.refetch()} /> : !q.data ? <Skeleton className="h-96" /> : <SettingsForm key={JSON.stringify(q.data)} view={q.data} />}
      {desktop && <DesktopPanel />}
    </>
  );
}

const LABEL: Record<string, string> = {
  maxSpendPerAction: 'Most chakra one action may spend',
  'autoBid.enabled': 'Automatic bidding',
  'autoBid.budget': 'Bidding budget',
  'autoBid.maxBid': 'Most chakra per copy',
  'autoTrade.enabled': 'Sending trades automatically',
  'autoTrade.budget': 'Chakra in pending trades',
};

function SettingsForm({ view }: { view: SettingsView }) {
  const [s, setS] = useState<Settings>(view.values);
  const [confirm, setConfirm] = useState<string[] | null>(null);
  const save = useSaveSettings();
  const toast = useToast();
  const locked = (f: SettingField) => view.locked[f];
  const dirty = JSON.stringify(s) !== JSON.stringify(view.values);

  const send = (confirmed: boolean) =>
    save.mutate(
      { settings: s, confirm: confirmed },
      {
        onSuccess: () => (setConfirm(null), toast({ kind: 'success', title: confirmed ? 'Limits raised' : 'Settings saved', detail: 'Running monitors restarted with the new limits.' })),
        onError: (e) => {
          if (e instanceof ApiError && e.code === 'confirm_required') setConfirm(raisedFields(view.values, s));
          else toast({ kind: 'error', title: 'Not saved', detail: explain(e) });
        },
      },
    );

  const numberField = (f: SettingField, value: number, on: (v: number) => void, hint: string) => (
    <Field label={LABEL[f]!} htmlFor={`set-${f}`} hint={locked(f) ? <LockedHint name={locked(f)!} /> : hint}>
      <input
        id={`set-${f}`}
        inputMode="numeric"
        disabled={!!locked(f)}
        value={value}
        onChange={(e) => on(Math.max(0, Math.floor(Number(e.target.value.replace(/\D/g, '')) || 0)))}
        className={cx(inputClass, 'num disabled:opacity-60')}
      />
    </Field>
  );
  const toggle = (f: SettingField, value: boolean, on: (v: boolean) => void, text: string) => (
    <label className={cx('flex items-start gap-3 text-sm', locked(f) && 'opacity-60')}>
      <input type="checkbox" className="mt-1 h-4 w-4 accent-[var(--color-warn)]" checked={value} disabled={!!locked(f)} onChange={(e) => on(e.target.checked)} />
      <span>
        <span className="font-bold">{LABEL[f]}</span>
        <span className="block text-muted">{text}</span>
        {locked(f) && <LockedHint name={locked(f)!} />}
      </span>
    </label>
  );

  return (
    <form
      className="grid max-w-[760px] gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        // ask first when a limit goes up (the server refuses it without the confirmation anyway)
        const raised = raisedFields(view.values, s).filter((f) => !locked(f as SettingField));
        if (raised.length) setConfirm(raised);
        else send(false);
      }}
    >
      <Panel title="Every action">
        {numberField('maxSpendPerAction', s.maxSpendPerAction, (v) => setS({ ...s, maxSpendPerAction: v }), 'Anything costing more is refused, by hand or automatic. Free actions are never blocked.')}
      </Panel>

      <Panel title="Auctions">
        <div className="flex flex-col gap-4">
          {toggle('autoBid.enabled', s.autoBid.enabled, (v) => setS({ ...s, autoBid: { ...s.autoBid, enabled: v } }), 'Lets market monitors place bids. Each monitor also has its own switch, copies target and maximum price.')}
          <div className="grid gap-4 sm:grid-cols-2">
            {numberField('autoBid.budget', s.autoBid.budget, (v) => setS({ ...s, autoBid: { ...s.autoBid, budget: v } }), 'Most chakra one monitor may have committed (bids still leading + copies won).')}
            {numberField('autoBid.maxBid', s.autoBid.maxBid, (v) => setS({ ...s, autoBid: { ...s.autoBid, maxBid: v } }), 'Caps every monitor’s maximum price.')}
          </div>
        </div>
      </Panel>

      <Panel title="Trades">
        <div className="flex flex-col gap-4">
          {toggle('autoTrade.enabled', s.autoTrade.enabled, (v) => setS({ ...s, autoTrade: { ...s.autoTrade, enabled: v } }), 'Lets chat-trade monitors set to “Send trades” actually send them. Otherwise they only preview.')}
          {numberField('autoTrade.budget', s.autoTrade.budget, (v) => setS({ ...s, autoTrade: { ...s.autoTrade, budget: v } }), '0 = card-for-card trades only. Otherwise the most chakra offered across pending trades.')}
        </div>
      </Panel>

      <div className="flex items-center justify-end gap-3">
        {dirty && <span className="text-sm text-muted">Unsaved changes</span>}
        <Button type="button" variant="ghost" disabled={!dirty} onClick={() => setS(view.values)}>
          Reset
        </Button>
        <Button type="submit" variant="primary" disabled={!dirty} busy={save.isPending && !confirm}>
          Save settings
        </Button>
      </div>

      <ConfirmDialog
        open={!!confirm}
        title="Let the bot spend more?"
        summary={confirm ? `This raises: ${confirm.map((f) => LABEL[f]?.toLowerCase() ?? f).join(', ')}. Running monitors restart with the new limits.` : null}
        cost={null}
        confirmLabel="Raise limits"
        busy={save.isPending}
        onClose={() => setConfirm(null)}
        onConfirm={() => send(true)}
      >
        <ul className="mt-3 flex flex-col gap-1 text-sm">
          {confirm?.map((f) => (
            <li key={f} className="num flex justify-between gap-4">
              <span className="text-muted">{LABEL[f]}</span>
              <span>
                {show(get(view.values, f))} {'->'} <span className="text-warn">{show(get(s, f))}</span>
              </span>
            </li>
          ))}
        </ul>
      </ConfirmDialog>
    </form>
  );
}

function DesktopPanel() {
  const [auto, setAuto] = useState<boolean | null>(null);
  useEffect(() => void desktop?.getAutoStart().then(setAuto), []);
  return (
    <Panel title="Desktop app" className="mt-4 max-w-[760px]">
      <div className="flex flex-col gap-3 text-sm">
        <label className="flex items-start gap-3">
          <input type="checkbox" className="mt-1 h-4 w-4" disabled={auto === null} checked={!!auto} onChange={(e) => void desktop?.setAutoStart(e.target.checked).then(setAuto)} />
          <span>
            <span className="font-bold">Start with Windows</span>
            <span className="block text-muted">Kyara Bot starts in the tray when you log in to Windows, so monitors keep running. Closing the window also keeps it in the tray; quit from the tray icon.</span>
          </span>
        </label>
        <div>
          <Button size="sm" variant="ghost" onClick={() => void desktop?.openDataFolder()}>
            Open the data folder
          </Button>
        </div>
      </div>
    </Panel>
  );
}

function LockedHint({ name }: { name: string }) {
  return (
    <span className="mt-1 inline-flex items-center gap-1 text-xs text-faint">
      <Lock size={11} aria-hidden /> Set by {name} in .env. Remove that line to manage it here.
    </span>
  );
}

function get(s: Settings, f: string): number | boolean {
  const [a, b] = f.split('.') as [keyof Settings, string?];
  const v = s[a];
  return b ? ((v as unknown as Record<string, number | boolean>)[b] as number | boolean) : (v as number);
}
const show = (v: number | boolean) => (typeof v === 'boolean' ? (v ? 'on' : 'off') : num(v));

function raisedFields(before: Settings, after: Settings): string[] {
  return Object.keys(LABEL).filter((f) => {
    const a = get(before, f);
    const b = get(after, f);
    return typeof a === 'boolean' ? !a && b === true : (b as number) > a;
  });
}
