import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { registerSecret } from '../utils/redact.js';

const StoredSessionSchema = z.object({
  version: z.literal(1),
  deviceId: z.string().min(1),
  token: z.string().min(8).nullable(),
  source: z.enum(['browser', 'manual', 'bridge', 'app', 'none']).default('none'),
  savedAt: z.string().nullable().default(null),
  /** Set when the server answered 401 with this token. */
  invalidatedAt: z.string().nullable().default(null),
  user: z
    .object({ id: z.string(), pseudo: z.string().nullable(), discordLinked: z.boolean() })
    .nullable()
    .default(null),
  pass: z.object({ pass: z.string(), expiresAt: z.number() }).nullable().default(null),
});
export type StoredSession = z.infer<typeof StoredSessionSchema>;

/** Short, non-reversible identifier of a secret, so two parties can compare tokens without sending them. */
export const fingerprint = (secret: string): string => createHash('sha256').update(secret).digest('hex').slice(0, 16);

export type SessionListener = (s: StoredSession) => void;

/**
 * The session (bearer token, device id, pack pass) in a JSON file in the data dir, written
 * atomically with mode 0600. A KYARA_TOKEN from the environment overrides the stored token
 * and is never written.
 */
export class SessionStore {
  private cached: StoredSession | null = null;
  private cachedMtimeMs = 0;
  private listeners = new Set<SessionListener>();

  constructor(
    private readonly file: string,
    private readonly envToken: string | null = null,
  ) {
    registerSecret(envToken);
  }

  get filePath(): string {
    return this.file;
  }

  /** Subscribe to every change (from this process or, on next read, from another one). */
  onChange(fn: SessionListener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  load(): StoredSession {
    // Another process (e.g. the CLI while `kyara serve` runs) may have rewritten the file.
    const mtime = this.mtime();
    if (this.cached && mtime === this.cachedMtimeMs) return this.cached;
    const hadCache = this.cached !== null;
    let data: StoredSession | null = null;
    if (mtime) {
      try {
        const parsed = StoredSessionSchema.safeParse(JSON.parse(fs.readFileSync(this.file, 'utf8')));
        if (parsed.success) data = parsed.data;
      } catch {
        data = null;
      }
    }
    data ??= {
      version: 1,
      deviceId: randomUUID(),
      token: null,
      source: 'none',
      savedAt: null,
      invalidatedAt: null,
      user: null,
      pass: null,
    };
    registerSecret(data.token);
    registerSecret(data.pass?.pass);
    this.cached = data;
    this.cachedMtimeMs = mtime;
    if (hadCache) this.emit(data);
    return data;
  }

  /** Fingerprint of the active token, or null. Never the token itself. */
  tokenFingerprint(): string | null {
    const t = this.token();
    return t ? fingerprint(t) : null;
  }

  /** The token to use: env override first, then the stored one (unless invalidated). */
  token(): string | null {
    if (this.envToken) return this.envToken;
    const s = this.load();
    return s.invalidatedAt ? null : s.token;
  }

  tokenSource(): 'env' | StoredSession['source'] {
    return this.envToken ? 'env' : this.load().source;
  }

  deviceId(): string {
    const s = this.load();
    if (!fs.existsSync(this.file)) this.save(s);
    return s.deviceId;
  }

  update(patch: Partial<Omit<StoredSession, 'version'>>): StoredSession {
    const next = { ...this.load(), ...patch };
    registerSecret(next.token);
    registerSecret(next.pass?.pass);
    this.save(next);
    return next;
  }

  markInvalid(): void {
    if (this.envToken) return;
    const s = this.load();
    if (s.token && !s.invalidatedAt) this.update({ invalidatedAt: new Date().toISOString(), pass: null });
  }

  /** Forgets the token and pass but keeps the device id (it identifies this machine, not the account). */
  clear(): void {
    this.update({ token: null, source: 'none', savedAt: null, invalidatedAt: null, user: null, pass: null });
  }

  private save(data: StoredSession): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
    this.cached = data;
    this.cachedMtimeMs = this.mtime();
    this.emit(data);
  }

  private mtime(): number {
    try {
      return fs.statSync(this.file).mtimeMs;
    } catch {
      return 0;
    }
  }

  private emit(data: StoredSession): void {
    for (const fn of this.listeners) {
      try {
        fn(data);
      } catch {
        /* a listener must not break persistence */
      }
    }
  }
}
