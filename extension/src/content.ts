/**
 * Runs on https://kyara.games/* only. Reads exactly three localStorage keys the site
 * itself maintains (kyara_token, kyara_device, kyara_pass) and hands them to the
 * extension's service worker. It never touches the page, Cloudflare, cookies or any
 * other storage key, and never logs values.
 */
import { SITE_KEYS } from '../../src/bridge/protocol.js';
import type { ContentToWorker, SiteSnapshot, WorkerToContent } from './messages.js';

const CHECK_EVERY_MS = 15_000;

function read(): SiteSnapshot {
  let pass: SiteSnapshot['pass'] = null;
  try {
    const raw = localStorage.getItem(SITE_KEYS.pass);
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    if (parsed && typeof parsed === 'object') {
      const p = parsed as { pass?: unknown; expiresAt?: unknown };
      if (typeof p.pass === 'string' && typeof p.expiresAt === 'number') pass = { pass: p.pass, expiresAt: p.expiresAt };
    }
  } catch {
    pass = null;
  }
  return { token: localStorage.getItem(SITE_KEYS.token), deviceId: localStorage.getItem(SITE_KEYS.device), pass };
}

function send(): void {
  const msg: ContentToWorker = { type: 'kyara:snapshot', snapshot: read(), visible: document.visibilityState === 'visible' };
  // The worker deduplicates: unchanged material is not forwarded to the bridge.
  chrome.runtime.sendMessage(msg).catch(() => undefined);
}

send();
setInterval(send, CHECK_EVERY_MS);
document.addEventListener('visibilitychange', send);
// Another kyara.games tab changed the session (login, logout, renewed pass).
window.addEventListener('storage', (e) => {
  if (e.key === SITE_KEYS.token || e.key === SITE_KEYS.pass || e.key === SITE_KEYS.device) send();
});
chrome.runtime.onMessage.addListener((msg: WorkerToContent) => {
  if (msg?.type === 'kyara:request-snapshot') send();
});
