/**
 * Kyara Bridge protocol, shared by the local server and the browser extension.
 * Pure WebCrypto (no Node imports) so the same code is bundled into the extension.
 *
 * Pairing:  extension POST /bridge/pair { code, label } with the one-time code the user
 *           reads from the app or terminal. The response carries a per-client secret
 *           exactly once. The code never travels in a URL.
 * Requests: every later call is signed:
 *             x-kyara-client: <clientId>
 *             x-kyara-ts:     <unix ms>
 *             x-kyara-nonce:  <random, single use>
 *             x-kyara-sig:    hex(HMAC-SHA256(secret, METHOD \n PATH \n ts \n nonce \n sha256hex(body)))
 *           The server rejects stale timestamps (±60 s), replayed nonces and bad signatures.
 */

export const BRIDGE_DEFAULT_PORT = 47321;
export const BRIDGE_PROTOCOL_VERSION = 1;
export const MAX_CLOCK_SKEW_MS = 60_000;

export const HEADERS = {
  client: 'x-kyara-client',
  ts: 'x-kyara-ts',
  nonce: 'x-kyara-nonce',
  sig: 'x-kyara-sig',
} as const;

/** What the content script may read from kyara.games localStorage. Nothing else. */
export const SITE_KEYS = { token: 'kyara_token', device: 'kyara_device', pass: 'kyara_pass' } as const;

export interface PairRequest {
  code: string;
  /** Free label shown in the app, e.g. "Chrome on desktop". */
  label: string;
}

export interface PairResponse {
  clientId: string;
  /** Base64 secret. Returned once; the server never sends it again. */
  secret: string;
  protocol: number;
}

/**
 * Session material sent by the extension. The token is only included when the bot says
 * it needs it (`needToken`), which it decides by comparing token fingerprints.
 */
export interface SyncRequest {
  /** sha256(token) truncated, or null when the site has no token (logged out). */
  tokenFp: string | null;
  token?: string;
  pass?: { pass: string; expiresAt: number } | null;
  deviceId?: string | null;
  /** True when the Kyara tab shows no session at all (user logged out). */
  loggedOut?: boolean;
}

export interface BotSessionView {
  hasToken: boolean;
  tokenMatches: boolean | null;
  pseudo: string | null;
  passValidForMs: number | null;
}

export interface SyncResponse {
  needToken: boolean;
  accepted: { token: boolean; pass: boolean; device: boolean };
  problems: string[];
  session: BotSessionView;
}

export interface StatusResponse {
  paired: true;
  clientId: string;
  session: BotSessionView;
  serverTime: number;
}

const enc = new TextEncoder();

function toHex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function base64ToBytes(b64: string): Uint8Array<ArrayBuffer> {
  const bin = atob(b64);
  const out = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function bytesToBase64(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

export async function sha256Hex(text: string): Promise<string> {
  return toHex(await crypto.subtle.digest('SHA-256', enc.encode(text)));
}

/** Same truncation as the server's token fingerprint. */
export async function tokenFingerprint(token: string): Promise<string> {
  return (await sha256Hex(token)).slice(0, 16);
}

export function canonicalString(method: string, path: string, ts: string, nonce: string, bodyHash: string): string {
  return [method.toUpperCase(), path, ts, nonce, bodyHash].join('\n');
}

export async function hmacHex(secretB64: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', base64ToBytes(secretB64), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return toHex(await crypto.subtle.sign('HMAC', key, enc.encode(message)));
}

export function randomNonce(): string {
  return toHex(crypto.getRandomValues(new Uint8Array(16)).buffer);
}

/** Builds the signed headers for a request (used by the extension and by tests). */
export async function signRequest(
  clientId: string,
  secretB64: string,
  method: string,
  path: string,
  body: string,
  now = Date.now(),
): Promise<Record<string, string>> {
  const ts = String(now);
  const nonce = randomNonce();
  const sig = await hmacHex(secretB64, canonicalString(method, path, ts, nonce, await sha256Hex(body)));
  return { [HEADERS.client]: clientId, [HEADERS.ts]: ts, [HEADERS.nonce]: nonce, [HEADERS.sig]: sig };
}

/** Normalises a pairing code the user typed: "abcd efgh" -> "ABCD-EFGH". */
export function normalizePairingCode(input: string): string {
  const raw = input.toUpperCase().replace(/[^A-Z0-9]/g, '');
  return raw.length === 8 ? `${raw.slice(0, 4)}-${raw.slice(4)}` : raw;
}
