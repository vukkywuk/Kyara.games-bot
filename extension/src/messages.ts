/** Messages between the content script, the service worker and the popup. */

/** Read from kyara.games localStorage. Only these three keys, nothing else. */
export interface SiteSnapshot {
  token: string | null;
  deviceId: string | null;
  pass: { pass: string; expiresAt: number } | null;
}

export type ContentToWorker = { type: 'kyara:snapshot'; snapshot: SiteSnapshot; visible: boolean };
export type WorkerToContent = { type: 'kyara:request-snapshot' };

export type PopupRequest =
  | { type: 'popup:state' }
  | { type: 'popup:pair'; port: number; code: string; label: string }
  | { type: 'popup:resync' }
  | { type: 'popup:unpair' }
  | { type: 'popup:check' };

export type BridgeState = 'unpaired' | 'connected' | 'unreachable' | 'rejected';

/** Everything the popup can show. Contains no token, pass or secret. */
export interface PopupState {
  bridge: BridgeState;
  port: number;
  label: string | null;
  pairedAt: string | null;
  kyaraTab: { seenAt: number | null; loggedIn: boolean | null; passExpiresAt: number | null; visible: boolean | null };
  lastSyncAt: number | null;
  lastCheckAt: number | null;
  lastError: string | null;
  problems: string[];
  bot: { hasToken: boolean; tokenMatches: boolean | null; pseudo: string | null; passValidForMs: number | null } | null;
}
