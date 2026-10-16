import { randomBytes, randomInt, randomUUID, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { SessionManager } from '../auth/SessionManager.js';
import {
  BRIDGE_PROTOCOL_VERSION,
  HEADERS,
  MAX_CLOCK_SKEW_MS,
  canonicalString,
  hmacHex,
  normalizePairingCode,
  sha256Hex,
} from '../bridge/protocol.js';
import type { PairResponse, StatusResponse, SyncResponse } from '../bridge/protocol.js';
import type { Logger } from '../utils/logger.js';
import { registerSecret } from '../utils/redact.js';
import { HttpError } from './http.js';
import { RateLimiter } from './RateLimiter.js';

const PAIRING_TTL_MS = 5 * 60_000;
const PAIRING_MAX_ATTEMPTS = 5;
/** No 0/O/1/I to avoid misreading. 32 symbols × 8 = 40 bits, single use, 5 attempts. */
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export const PairBodySchema = z.object({
  code: z.string().min(4).max(32),
  label: z.string().trim().min(1).max(60).default('Browser extension'),
}).strict();

const PassBody = z.object({ pass: z.string().min(1).max(4096), expiresAt: z.number().int().positive() }).strict();
export const SyncBodySchema = z
  .object({
    tokenFp: z.string().regex(/^[0-9a-f]{16}$/).nullable(),
    token: z.string().min(8).max(4096).optional(),
    pass: PassBody.nullable().optional(),
    deviceId: z.string().max(128).nullable().optional(),
    loggedOut: z.boolean().optional(),
  })
  .strict();

const ClientSchema = z.object({
  id: z.string(),
  secret: z.string(),
  origin: z.string(),
  label: z.string(),
  pairedAt: z.string(),
  lastSeenAt: z.string().nullable(),
  lastSyncAt: z.string().nullable(),
});
type Client = z.infer<typeof ClientSchema>;
const StateSchema = z.object({ version: z.literal(1), clients: z.array(ClientSchema) });

export interface PublicClient {
  id: string;
  label: string;
  pairedAt: string;
  lastSeenAt: string | null;
  lastSyncAt: string | null;
}

export interface BridgeEvents {
  onEvent?(type: string, data: Record<string, unknown>): void;
}

/**
 * The bridge side of the extension integration. It accepts exactly four operations
 * (pair, status, sync, unpair) and never returns session material.
 */
export class BridgeService {
  private pairing: { code: string; expiresAt: number; attempts: number } | null = null;
  private nonces = new Map<string, number>();
  private readonly pairLimiter = new RateLimiter(10, 5 * 60_000);
  private readonly authFailLimiter = new RateLimiter(30, 60_000);
  private readonly syncLimiter = new RateLimiter(60, 60_000);
  private state: z.infer<typeof StateSchema> | null = null;
  private stateMtime = 0;

  constructor(
    private readonly file: string,
    private readonly session: SessionManager,
    private readonly log: Logger,
    private readonly events: BridgeEvents = {},
    private readonly now: () => number = Date.now,
  ) {}

  // ---------------------------------------------------------------- pairing

  /** New one-time code (replaces any previous one). Shown in the app / terminal only. */
  createPairingCode(): { code: string; expiresAt: number } {
    let raw = '';
    for (let i = 0; i < 8; i++) raw += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
    const code = `${raw.slice(0, 4)}-${raw.slice(4)}`;
    this.pairing = { code, expiresAt: this.now() + PAIRING_TTL_MS, attempts: 0 };
    this.events.onEvent?.('bridge.pairing', { expiresAt: this.pairing.expiresAt });
    return { code, expiresAt: this.pairing.expiresAt };
  }

  pairingPending(): { expiresAt: number } | null {
    return this.pairing && this.pairing.expiresAt > this.now() ? { expiresAt: this.pairing.expiresAt } : null;
  }

  cancelPairing(): void {
    this.pairing = null;
  }

  pair(body: unknown, origin: string | undefined): PairResponse {
    // Origin first: a web page must not be able to exhaust the pairing rate limit.
    if (!origin || !/^(chrome|moz)-extension:\/\/[a-z0-9-]+$/i.test(origin)) {
      throw new HttpError(403, 'bad_origin', 'Pairing is only accepted from the browser extension');
    }
    if (this.pairLimiter.hit('pair')) throw new HttpError(429, 'rate_limited', 'Too many pairing attempts; wait a few minutes');
    const parsed = PairBodySchema.safeParse(body);
    if (!parsed.success) throw new HttpError(400, 'bad_request', 'Expected { code, label }');
    const p = this.pairing;
    if (!p || p.expiresAt <= this.now()) throw new HttpError(401, 'no_pairing', 'No active pairing code. Generate one in the app.');
    p.attempts++;
    const given = Buffer.from(normalizePairingCode(parsed.data.code));
    const expected = Buffer.from(p.code);
    const ok = given.length === expected.length && timingSafeEqual(given, expected);
    if (!ok) {
      if (p.attempts >= PAIRING_MAX_ATTEMPTS) this.pairing = null;
      throw new HttpError(401, 'bad_code', p.attempts >= PAIRING_MAX_ATTEMPTS ? 'Wrong code; generate a new one' : 'Wrong code');
    }
    this.pairing = null;
    const client: Client = {
      id: randomUUID(),
      secret: randomBytes(32).toString('base64'),
      origin,
      label: parsed.data.label,
      pairedAt: new Date(this.now()).toISOString(),
      lastSeenAt: null,
      lastSyncAt: null,
    };
    const state = this.load();
    state.clients.push(client);
    this.save(state);
    registerSecret(client.secret);
    this.log.info(`Extension paired: ${client.label} (${client.id.slice(0, 8)})`);
    this.events.onEvent?.('bridge.paired', { clientId: client.id, label: client.label });
    return { clientId: client.id, secret: client.secret, protocol: BRIDGE_PROTOCOL_VERSION };
  }

  // ---------------------------------------------------------------- authenticated operations

  /** Verifies the HMAC signature, timestamp and nonce. Returns the client. */
  async authenticate(
    headers: Record<string, string | string[] | undefined>,
    method: string,
    pathname: string,
    rawBody: string,
    origin: string | undefined,
  ): Promise<Client> {
    const fail = (msg: string): never => {
      if (this.authFailLimiter.hit('auth')) throw new HttpError(429, 'rate_limited', 'Too many failed requests');
      throw new HttpError(401, 'unauthorized', msg);
    };
    const h = (k: string): string | undefined => {
      const v = headers[k];
      return typeof v === 'string' ? v : undefined;
    };
    const clientId = h(HEADERS.client);
    const ts = h(HEADERS.ts);
    const nonce = h(HEADERS.nonce);
    const sig = h(HEADERS.sig);
    if (!clientId || !ts || !nonce || !sig) return fail('Missing signature headers');
    const client = this.load().clients.find((c) => c.id === clientId);
    if (!client) return fail('Unknown client; pair the extension again');
    // Defence in depth only (the signature is the authentication): browsers do not always
    // send Origin on an extension's GET, so a missing Origin is allowed, a different one is not.
    if (origin !== undefined && origin !== client.origin) return fail('Origin mismatch');
    const tsNum = Number(ts);
    if (!Number.isFinite(tsNum) || Math.abs(this.now() - tsNum) > MAX_CLOCK_SKEW_MS) return fail('Stale or invalid timestamp');
    if (!/^[0-9a-f]{32}$/.test(nonce)) return fail('Invalid nonce');
    this.pruneNonces();
    const nonceKey = `${clientId}:${nonce}`;
    if (this.nonces.has(nonceKey)) return fail('Replayed request');
    // Reserve the nonce before any await, so two concurrent copies cannot both pass.
    this.nonces.set(nonceKey, this.now() + 2 * MAX_CLOCK_SKEW_MS);
    const expected = await hmacHex(client.secret, canonicalString(method, pathname, ts, nonce, await sha256Hex(rawBody)));
    const a = Buffer.from(sig);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      this.nonces.delete(nonceKey);
      return fail('Bad signature');
    }
    return client;
  }

  status(client: Client): StatusResponse {
    this.touch(client.id, false);
    return { paired: true, clientId: client.id, session: this.session.view(), serverTime: this.now() };
  }

  async sync(client: Client, body: unknown): Promise<SyncResponse> {
    if (this.syncLimiter.hit(client.id)) throw new HttpError(429, 'rate_limited', 'Too many sync requests');
    const parsed = SyncBodySchema.safeParse(body);
    if (!parsed.success) throw new HttpError(400, 'bad_request', 'Invalid sync payload');
    const res = await this.session.applyBridgeSync(parsed.data);
    const changed = res.accepted.pass || res.accepted.token || res.accepted.device || !!parsed.data.loggedOut;
    this.touch(client.id, changed);
    this.events.onEvent?.('bridge.sync', {
      clientId: client.id,
      accepted: res.accepted,
      problems: res.problems,
      loggedOut: !!parsed.data.loggedOut,
      bot: res.session,
    });
    return res;
  }

  unpair(clientId: string): boolean {
    const state = this.load();
    const before = state.clients.length;
    state.clients = state.clients.filter((c) => c.id !== clientId);
    if (state.clients.length === before) return false;
    this.save(state);
    this.events.onEvent?.('bridge.unpaired', { clientId });
    return true;
  }

  clients(): PublicClient[] {
    return this.load().clients.map(({ id, label, pairedAt, lastSeenAt, lastSyncAt }) => ({ id, label, pairedAt, lastSeenAt, lastSyncAt }));
  }

  // ---------------------------------------------------------------- persistence

  private touch(clientId: string, synced: boolean): void {
    const state = this.load();
    const c = state.clients.find((x) => x.id === clientId);
    if (!c) return;
    const iso = new Date(this.now()).toISOString();
    c.lastSeenAt = iso;
    if (synced) c.lastSyncAt = iso;
    this.save(state);
  }

  private pruneNonces(): void {
    const t = this.now();
    for (const [k, exp] of this.nonces) if (exp <= t) this.nonces.delete(k);
  }

  private mtime(): number {
    try {
      return fs.statSync(this.file).mtimeMs;
    } catch {
      return 0;
    }
  }

  /** Reloads when `kyara bridge unpair` (another process) changed the file. */
  private load(): z.infer<typeof StateSchema> {
    const m = this.mtime();
    if (this.state && m === this.stateMtime) return this.state;
    let state: z.infer<typeof StateSchema> = { version: 1, clients: [] };
    if (m) {
      try {
        const parsed = StateSchema.safeParse(JSON.parse(fs.readFileSync(this.file, 'utf8')));
        if (parsed.success) state = parsed.data;
        else this.log.warn('bridge.json is malformed; treating as unpaired');
      } catch {
        this.log.warn('bridge.json is unreadable; treating as unpaired');
      }
    }
    for (const c of state.clients) registerSecret(c.secret);
    this.state = state;
    this.stateMtime = m;
    return state;
  }

  private save(state: z.infer<typeof StateSchema>): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
    this.state = state;
    this.stateMtime = this.mtime();
  }
}

/** Used by `kyara bridge` CLI commands (no running server needed). */
export function readBridgeClients(file: string): PublicClient[] {
  try {
    const parsed = StateSchema.safeParse(JSON.parse(fs.readFileSync(file, 'utf8')));
    return parsed.success ? parsed.data.clients.map(({ id, label, pairedAt, lastSeenAt, lastSyncAt }) => ({ id, label, pairedAt, lastSeenAt, lastSyncAt })) : [];
  } catch {
    return [];
  }
}
