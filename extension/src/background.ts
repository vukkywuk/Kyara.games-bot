/**
 * Service worker. Holds the pairing (client id + secret, needed to sign requests) in
 * chrome.storage.local, and only fingerprints / status in chrome.storage.session
 * (memory only, cleared when the browser closes). Session material from the page is
 * kept in a local variable just long enough to forward it, and is never logged.
 */
import {
  BRIDGE_DEFAULT_PORT,
  normalizePairingCode,
  sha256Hex,
  signRequest,
  tokenFingerprint,
} from '../../src/bridge/protocol.js';
import type { PairResponse, StatusResponse, SyncRequest, SyncResponse } from '../../src/bridge/protocol.js';
import type { ContentToWorker, PopupRequest, PopupState, SiteSnapshot, WorkerToContent } from './messages.js';
import { planSync } from './syncPolicy.js';
import type { SyncMemory } from './syncPolicy.js';

interface Pairing {
  clientId: string;
  secret: string;
  port: number;
  label: string;
  pairedAt: string;
}

type Status = Omit<PopupState, 'port' | 'label' | 'pairedAt'> & { memory: SyncMemory | null };

const REQUEST_TIMEOUT_MS = 6000;

const defaultStatus = (): Status => ({
  bridge: 'unpaired',
  kyaraTab: { seenAt: null, loggedIn: null, passExpiresAt: null, visible: null },
  lastSyncAt: null,
  lastCheckAt: null,
  lastError: null,
  problems: [],
  bot: null,
  memory: null,
});

async function getPairing(): Promise<Pairing | null> {
  const { pairing } = await chrome.storage.local.get('pairing');
  return (pairing as Pairing | undefined) ?? null;
}

async function getStatus(): Promise<Status> {
  const { status } = await chrome.storage.session.get('status');
  return { ...defaultStatus(), ...((status as Status | undefined) ?? {}) };
}

async function setStatus(patch: Partial<Status>): Promise<Status> {
  const next = { ...(await getStatus()), ...patch };
  await chrome.storage.session.set({ status: next });
  return next;
}

class BridgeError extends Error {
  constructor(
    message: string,
    readonly kind: 'unreachable' | 'rejected' | 'http',
  ) {
    super(message);
  }
}

async function call<T>(p: Pairing | { port: number }, method: string, path: string, body?: unknown): Promise<T> {
  const text = body === undefined ? '' : JSON.stringify(body);
  const headers: Record<string, string> = body === undefined ? {} : { 'content-type': 'application/json' };
  if ('secret' in p) Object.assign(headers, await signRequest(p.clientId, p.secret, method, path, text));
  let res: Response;
  try {
    res = await fetch(`http://127.0.0.1:${p.port}${path}`, {
      method,
      headers,
      body: text || undefined,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      credentials: 'omit',
      cache: 'no-store',
    });
  } catch {
    throw new BridgeError(`The Kyara bot is not reachable on port ${p.port}. Is \`kyara serve\` running?`, 'unreachable');
  }
  const data = (await res.json().catch(() => ({}))) as { error?: { code?: string; message?: string } } & T;
  if (!res.ok) {
    const code = data.error?.code ?? `http_${res.status}`;
    const msg = data.error?.message ?? `Bridge answered ${res.status}`;
    if (res.status === 401 && 'secret' in p && /Unknown client/.test(msg)) throw new BridgeError('This pairing was revoked in the app. Pair again.', 'rejected');
    throw new BridgeError(`${msg} (${code})`, 'http');
  }
  return data;
}

let latest: { snapshot: SiteSnapshot; visible: boolean } | null = null;
let syncing: Promise<void> = Promise.resolve();

async function handleSnapshot(snapshot: SiteSnapshot, visible: boolean): Promise<void> {
  latest = { snapshot, visible };
  await setStatus({
    kyaraTab: { seenAt: Date.now(), loggedIn: !!snapshot.token, passExpiresAt: snapshot.pass?.expiresAt ?? null, visible },
  });
  // one sync at a time; a burst of snapshots collapses into sequential, deduplicated work
  syncing = syncing.then(() => syncNow(false)).catch(() => undefined);
  await syncing;
}

async function syncNow(force: boolean): Promise<void> {
  const pairing = await getPairing();
  if (!pairing || !latest) return;
  const { snapshot } = latest;
  const status = await getStatus();
  const tokenFp = snapshot.token ? await tokenFingerprint(snapshot.token) : null;
  const passFp = snapshot.pass ? (await sha256Hex(snapshot.pass.pass)).slice(0, 16) : null;
  const plan = planSync(snapshot, tokenFp, passFp, force ? null : status.memory, Date.now());
  if (!plan.send) return;
  try {
    let res = await call<SyncResponse>(pairing, 'POST', '/bridge/sync', plan.body);
    if (res.needToken && snapshot.token) {
      const withToken: SyncRequest = { ...plan.body, token: snapshot.token, pass: snapshot.pass ?? undefined };
      res = await call<SyncResponse>(pairing, 'POST', '/bridge/sync', withToken);
    }
    await setStatus({ bridge: 'connected', lastSyncAt: Date.now(), lastError: null, problems: res.problems, bot: res.session, memory: plan.next });
  } catch (err) {
    const e = err as BridgeError;
    if (e.kind === 'rejected') await chrome.storage.local.remove('pairing');
    await setStatus({ bridge: e.kind === 'rejected' ? 'unpaired' : e.kind === 'unreachable' ? 'unreachable' : 'connected', lastError: e.message });
  }
}

async function checkBridge(): Promise<void> {
  const pairing = await getPairing();
  if (!pairing) return void (await setStatus({ bridge: 'unpaired' }));
  try {
    const res = await call<StatusResponse>(pairing, 'GET', '/bridge/status');
    await setStatus({ bridge: 'connected', bot: res.session, lastCheckAt: Date.now(), lastError: null });
  } catch (err) {
    const e = err as BridgeError;
    if (e.kind === 'rejected') await chrome.storage.local.remove('pairing');
    await setStatus({ bridge: e.kind === 'rejected' ? 'rejected' : 'unreachable', lastCheckAt: Date.now(), lastError: e.message });
  }
}

async function requestSnapshots(): Promise<void> {
  const tabs = await chrome.tabs.query({ url: 'https://kyara.games/*' });
  const msg: WorkerToContent = { type: 'kyara:request-snapshot' };
  await Promise.all(tabs.map((t) => (t.id ? chrome.tabs.sendMessage(t.id, msg).catch(() => undefined) : undefined)));
}

async function popupState(): Promise<PopupState> {
  const [p, s] = await Promise.all([getPairing(), getStatus()]);
  const { memory: _memory, ...rest } = s;
  return { ...rest, bridge: p ? (s.bridge === 'unpaired' ? 'connected' : s.bridge) : s.bridge === 'rejected' ? 'rejected' : 'unpaired', port: p?.port ?? BRIDGE_DEFAULT_PORT, label: p?.label ?? null, pairedAt: p?.pairedAt ?? null };
}

async function onPopup(msg: PopupRequest): Promise<PopupState | { error: string }> {
  try {
    switch (msg.type) {
      case 'popup:state':
        return popupState();
      case 'popup:check':
        await checkBridge();
        return popupState();
      case 'popup:pair': {
        if (!Number.isInteger(msg.port) || msg.port < 1024 || msg.port > 65535) return { error: 'Port must be between 1024 and 65535.' };
        const code = normalizePairingCode(msg.code);
        if (!/^[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(code)) return { error: 'The code has 8 characters, like ABCD-EFGH.' };
        const res = await call<PairResponse>({ port: msg.port }, 'POST', '/bridge/pair', { code, label: msg.label.slice(0, 60) || 'Browser' });
        await chrome.storage.local.set({ pairing: { clientId: res.clientId, secret: res.secret, port: msg.port, label: msg.label, pairedAt: new Date().toISOString() } satisfies Pairing });
        await setStatus({ bridge: 'connected', lastError: null, memory: null });
        await requestSnapshots();
        await checkBridge();
        return popupState();
      }
      case 'popup:resync':
        await setStatus({ memory: null });
        await requestSnapshots();
        if (latest) await syncNow(true);
        await checkBridge();
        return popupState();
      case 'popup:unpair': {
        const p = await getPairing();
        if (p) await call(p, 'DELETE', '/bridge/pair').catch(() => undefined);
        await chrome.storage.local.remove('pairing');
        await chrome.storage.session.set({ status: defaultStatus() });
        return popupState();
      }
    }
  } catch (err) {
    await setStatus({ lastError: (err as Error).message });
    return { error: (err as Error).message };
  }
}

chrome.runtime.onMessage.addListener((msg: ContentToWorker | PopupRequest, sender, sendResponse) => {
  if (msg.type === 'kyara:snapshot') {
    // Accept snapshots only from our own content script on kyara.games.
    if (sender.id !== chrome.runtime.id || !sender.url?.startsWith('https://kyara.games/')) return false;
    void handleSnapshot(msg.snapshot, msg.visible);
    return false;
  }
  // Popup only: our own extension page, never a content script or another extension.
  if (sender.id !== chrome.runtime.id || !sender.url?.startsWith(chrome.runtime.getURL('popup.html'))) return false;
  onPopup(msg).then(sendResponse);
  return true;
});

chrome.runtime.onInstalled.addListener(() => void requestSnapshots());
chrome.runtime.onStartup.addListener(() => void requestSnapshots());
