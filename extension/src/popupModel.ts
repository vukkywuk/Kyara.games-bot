import type { PopupState } from './messages.js';

export type Tone = 'ok' | 'warn' | 'bad' | 'idle';
export interface Row {
  label: string;
  value: string;
  tone: Tone;
}

export function ago(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  return `${Math.round(s / 3600)} h ago`;
}

export function minutes(ms: number): string {
  const m = Math.floor(ms / 60_000);
  return m >= 1 ? `${m} min` : 'under a minute';
}

/** Turns worker state into the popup's rows. Pure, so it is unit-tested. */
export function describeState(s: PopupState, now: number): { rows: Row[]; note: string | null } {
  const rows: Row[] = [];
  const paired = s.bridge !== 'unpaired' && s.bridge !== 'rejected';

  rows.push(
    s.bridge === 'connected'
      ? { label: 'Bot', value: `Connected on port ${s.port}`, tone: 'ok' }
      : s.bridge === 'unreachable'
        ? { label: 'Bot', value: `Not reachable on port ${s.port}`, tone: 'bad' }
        : s.bridge === 'rejected'
          ? { label: 'Bot', value: 'Pairing revoked', tone: 'bad' }
          : { label: 'Bot', value: 'Not paired', tone: 'idle' },
  );

  const tab = s.kyaraTab;
  const tabFresh = tab.seenAt !== null && now - tab.seenAt < 60_000;
  rows.push(
    !tabFresh
      ? { label: 'Kyara tab', value: 'No open kyara.games tab', tone: 'warn' }
      : tab.loggedIn
        ? { label: 'Kyara tab', value: tab.visible ? 'Open and logged in' : 'Open in the background', tone: 'ok' }
        : { label: 'Kyara tab', value: 'Open, not logged in', tone: 'warn' },
  );

  const passLeft = tab.passExpiresAt ? tab.passExpiresAt - now : null;
  rows.push(
    passLeft === null || !tabFresh
      ? { label: 'Pack pass', value: 'None yet', tone: 'idle' }
      : passLeft <= 60_000
        ? { label: 'Pack pass', value: 'Expired', tone: 'bad' }
        : { label: 'Pack pass', value: `Valid for ${minutes(passLeft)}`, tone: passLeft < 5 * 60_000 ? 'warn' : 'ok' },
  );

  if (paired && s.bot) {
    rows.push(
      !s.bot.hasToken
        ? { label: 'Bot session', value: 'No session yet', tone: 'warn' }
        : s.bot.tokenMatches === false
          ? { label: 'Bot session', value: 'Different account than this tab', tone: 'warn' }
          : { label: 'Bot session', value: s.bot.pseudo ? `Logged in as ${s.bot.pseudo}` : 'Logged in', tone: 'ok' },
    );
  }
  if (paired) rows.push({ label: 'Last sync', value: s.lastSyncAt ? ago(now - s.lastSyncAt) : 'Not yet', tone: s.lastSyncAt ? 'ok' : 'idle' });

  let note: string | null = null;
  if (s.problems.length) note = s.problems.join(' ');
  else if (tabFresh && tab.loggedIn && !tab.visible && passLeft !== null && passLeft < 5 * 60_000) {
    note = 'Kyara renews the pass only while its tab is visible. Bring the tab to the front for a few seconds.';
  } else if (!tabFresh && paired) note = 'Open kyara.games and log in. The bridge picks the session up automatically.';
  return { rows, note };
}
