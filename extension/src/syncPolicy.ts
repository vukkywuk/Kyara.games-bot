import type { SyncRequest } from '../../src/bridge/protocol.js';
import type { SiteSnapshot } from './messages.js';

/** A pass this close to expiry is not worth sending (the bot would refuse it). */
export const MIN_PASS_REMAINING_MS = 60_000;
/** Without changes, a light status-only sync at most this often (no session material). */
export const HEARTBEAT_MS = 10 * 60_000;

/** What was last delivered to the bridge. Fingerprints only, never the values. */
export interface SyncMemory {
  tokenFp: string | null;
  passFp: string | null;
  deviceId: string | null;
  loggedOut: boolean;
  at: number;
}

export interface SyncPlan {
  send: boolean;
  reason: 'first' | 'token-changed' | 'pass-changed' | 'device-changed' | 'logged-out' | 'logged-in' | 'heartbeat' | 'unchanged';
  body: SyncRequest;
  /** Memory to store once the bridge accepted the request. */
  next: SyncMemory;
}

/**
 * Decides whether to contact the bridge and with what. The token is never included
 * here: it is only sent when the bridge answers `needToken` (fingerprint mismatch).
 */
export function planSync(snap: SiteSnapshot, tokenFp: string | null, passFp: string | null, last: SyncMemory | null, now: number): SyncPlan {
  const loggedOut = !snap.token;
  const passUsable = !!snap.pass && snap.pass.expiresAt - now > MIN_PASS_REMAINING_MS;
  const usablePassFp = passUsable ? passFp : null;
  const next: SyncMemory = { tokenFp, passFp: usablePassFp ?? last?.passFp ?? null, deviceId: snap.deviceId, loggedOut, at: now };

  let reason: SyncPlan['reason'] = 'unchanged';
  if (!last) reason = 'first';
  else if (loggedOut !== last.loggedOut) reason = loggedOut ? 'logged-out' : 'logged-in';
  else if (tokenFp !== last.tokenFp) reason = 'token-changed';
  else if (usablePassFp && usablePassFp !== last.passFp) reason = 'pass-changed';
  else if (snap.deviceId !== last.deviceId) reason = 'device-changed';
  else if (now - last.at >= HEARTBEAT_MS) reason = 'heartbeat';

  const body: SyncRequest = { tokenFp: loggedOut ? null : tokenFp };
  if (loggedOut) body.loggedOut = true;
  else {
    if (snap.deviceId) body.deviceId = snap.deviceId;
    // the pass travels only when it is new (or on first contact / session change)
    if (passUsable && reason !== 'heartbeat' && reason !== 'unchanged' && (reason !== 'device-changed' || usablePassFp !== last?.passFp)) {
      body.pass = snap.pass;
    }
  }
  if (loggedOut) next.passFp = null;
  return { send: reason !== 'unchanged', reason, body, next };
}
