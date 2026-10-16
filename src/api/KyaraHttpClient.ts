import { randomUUID } from 'node:crypto';
import type { z } from 'zod';
import {
  AuthRequiredError,
  KyaraApiError,
  NetworkError,
  RateLimitedError,
  SchemaMismatchError,
  describeServerCode,
} from '../utils/errors.js';
import type { Logger } from '../utils/logger.js';
import { silentLogger } from '../utils/logger.js';
import { redactString } from '../utils/redact.js';
import { ServerClock, sleep as realSleep } from '../utils/time.js';
import { ErrorBodySchema } from './schemas/common.js';
import { FetchTransport, TransportFailure } from './transport.js';
import type { Transport, TransportRequest, TransportResponse } from './transport.js';

export type AuthMode = 'none' | 'optional' | 'required';
export type Query = Record<string, string | number | boolean | null | undefined>;

export interface RequestOptions {
  auth?: AuthMode;
  query?: Query;
  headers?: Record<string, string>;
}

export interface MutationOptions extends RequestOptions {
  body?: unknown;
}

export interface CredentialSource {
  /** Bearer token, or null when not logged in. */
  getToken(): string | null;
  /** Stable device id, sent as `x-device-id` like the site does. */
  getDeviceId(): string;
  /** Called when the server rejects the token so the session can be marked invalid. */
  onUnauthorized?(): void;
}

export interface HttpClientOptions {
  baseUrl: string;
  credentials: CredentialSource;
  transport?: Transport;
  timeoutMs?: number;
  /** Retries for idempotent (GET) requests only. Mutations are never retried here. */
  maxRetries?: number;
  /** Minimum spacing between two requests, in ms. */
  minIntervalMs?: number;
  logger?: Logger;
  /** Injected in tests. */
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
}

export interface RateLimitState {
  limit: number | null;
  remaining: number | null;
  resetAt: number | null;
}

/** Transient error codes for which the site itself retries GETs. */
const RETRYABLE_503_CODES = new Set(['catalog_loading', 'starting']);
const MAX_BACKOFF_MS = 30_000;

export function buildQuery(query: Query | undefined): string {
  if (!query) return '';
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (v === undefined || v === null || v === '') continue;
    p.set(k, String(v));
  }
  const s = p.toString();
  return s ? `?${s}` : '';
}

/**
 * The single HTTP entry point. Responsibilities:
 * - auth headers (`authorization: Bearer`, `x-device-id`), never logged;
 * - serialised, spaced requests (no unbounded concurrency);
 * - honouring `x-ratelimit-*` and `retry-after`;
 * - bounded retries with jittered backoff for GETs;
 * - zod validation of every response;
 * - typed errors.
 */
export class KyaraHttpClient {
  readonly clock = new ServerClock();
  readonly rateLimit: RateLimitState = { limit: null, remaining: null, resetAt: null };
  private readonly transport: Transport;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly minIntervalMs: number;
  private readonly log: Logger;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly random: () => number;
  private queue: Promise<unknown> = Promise.resolve();
  private lastRequestAt = 0;

  constructor(private readonly opts: HttpClientOptions) {
    this.transport = opts.transport ?? new FetchTransport();
    this.timeoutMs = opts.timeoutMs ?? 15_000;
    this.maxRetries = opts.maxRetries ?? 3;
    this.minIntervalMs = opts.minIntervalMs ?? 250;
    this.log = opts.logger ?? silentLogger;
    this.sleep = opts.sleep ?? realSleep;
    this.random = opts.random ?? Math.random;
  }

  get baseUrl(): string {
    return this.opts.baseUrl;
  }

  get transportName(): string {
    return this.transport.name;
  }

  hasToken(): boolean {
    return !!this.opts.credentials.getToken();
  }

  /** Read-only request with retries. */
  async get<S extends z.ZodType>(path: string, schema: S, options: RequestOptions = {}): Promise<z.infer<S>> {
    const url = this.opts.baseUrl + '/api' + path + buildQuery(options.query);
    let attempt = 0;
    for (;;) {
      try {
        const res = await this.execute('GET', url, path, options);
        return this.parse(path, schema, res);
      } catch (err) {
        const delay = this.retryDelay(err, attempt);
        if (delay === null) throw err;
        attempt++;
        this.log.warn(`GET ${path} failed, retrying in ${delay} ms (attempt ${attempt}/${this.maxRetries})`, {
          reason: (err as Error).message,
        });
        await this.sleep(delay);
      }
    }
  }

  /**
   * State-changing request. Sent exactly once: retries of mutations are the caller's
   * decision (see ActionGuard), because the outcome of a failed mutation is unknown.
   */
  async mutate<S extends z.ZodType>(
    method: 'POST' | 'PUT' | 'PATCH' | 'DELETE',
    path: string,
    schema: S,
    options: MutationOptions = {},
  ): Promise<z.infer<S>> {
    const url = this.opts.baseUrl + '/api' + path + buildQuery(options.query);
    const res = await this.execute(method, url, path, { auth: 'required', ...options });
    return this.parse(path, schema, res);
  }

  /** Builds an absolute URL (used for the SSE event stream). */
  url(path: string, query?: Query): string {
    return this.opts.baseUrl + '/api' + path + buildQuery(query);
  }

  private retryDelay(err: unknown, attempt: number): number | null {
    if (attempt >= this.maxRetries) return null;
    const backoff = Math.min(MAX_BACKOFF_MS, 1000 * 2 ** attempt) * (0.75 + this.random() * 0.5);
    if (err instanceof RateLimitedError) {
      return err.retryAfterMs !== null && err.retryAfterMs <= 120_000 ? Math.max(err.retryAfterMs, 1000) : null;
    }
    if (err instanceof NetworkError) return Math.round(backoff);
    if (err instanceof KyaraApiError) {
      if (err.status === 503 && RETRYABLE_503_CODES.has(err.code)) return 1500;
      if (err.status === 502 || err.status === 503 || err.status === 504) return Math.round(backoff);
    }
    return null;
  }

  private async execute(
    method: TransportRequest['method'],
    url: string,
    path: string,
    options: MutationOptions,
  ): Promise<TransportResponse> {
    const auth = options.auth ?? 'none';
    const token = auth === 'none' ? null : this.opts.credentials.getToken();
    if (auth === 'required' && !token) throw new AuthRequiredError();

    const headers: Record<string, string> = {
      'x-device-id': this.opts.credentials.getDeviceId(),
      ...options.headers,
    };
    if (token) headers.authorization = `Bearer ${token}`;
    let body: string | undefined;
    if (options.body !== undefined) {
      body = JSON.stringify(options.body);
      headers['content-type'] = 'application/json';
    }

    const res = await this.enqueue(() => this.sendOnce({ method, url, headers, body, timeoutMs: this.timeoutMs }, path));

    if (res.status >= 200 && res.status < 300) return res;

    const parsed = ErrorBodySchema.safeParse(safeJson(res.text));
    const code = parsed.success ? parsed.data.error : `http_${res.status}`;
    const message = describeServerCode(code, parsed.success ? parsed.data.message : undefined);

    if (res.status === 401) {
      if (token) this.opts.credentials.onUnauthorized?.();
      throw new AuthRequiredError(
        token ? 'The session was rejected by the server (expired or revoked). Run `kyara session login`.' : undefined,
      );
    }
    if (res.status === 429) {
      throw new RateLimitedError(`Rate limited on ${path}: ${message}`, retryAfterMs(res, this.clock.now()));
    }
    throw new KyaraApiError(res.status, code, message, path);
  }

  /** Serialises requests and enforces spacing plus proactive rate-limit waiting. */
  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const run = async (): Promise<T> => {
      const now = Date.now();
      let wait = Math.max(0, this.lastRequestAt + this.minIntervalMs - now);
      const rl = this.rateLimit;
      if (rl.remaining !== null && rl.limit !== null && rl.resetAt !== null && rl.remaining <= Math.ceil(rl.limit * 0.02)) {
        wait = Math.max(wait, rl.resetAt - this.clock.now());
        this.log.warn(`Close to the server rate limit (${rl.remaining}/${rl.limit} left); pausing ${wait} ms`);
      }
      if (wait > 0) await this.sleep(Math.min(wait, 120_000));
      this.lastRequestAt = Date.now();
      return fn();
    };
    const p = this.queue.then(run, run);
    this.queue = p.catch(() => undefined);
    return p;
  }

  private async sendOnce(req: TransportRequest, path: string): Promise<TransportResponse> {
    const started = Date.now();
    const reqId = randomUUID().slice(0, 8);
    let res: TransportResponse;
    try {
      res = await this.transport.send(req);
    } catch (err) {
      if (err instanceof TransportFailure) {
        this.log.debug(`${req.method} ${path} -> ${err.kind}`, { reqId, ms: Date.now() - started });
        throw new NetworkError(`${err.message} (${req.method} ${path})`, { cause: err });
      }
      throw err;
    }
    this.clock.observe(res.headers.get('date'));
    this.observeRateLimit(res);
    this.log.debug(`${req.method} ${redactString(path)} -> ${res.status}`, {
      reqId,
      ms: Date.now() - started,
      rateRemaining: this.rateLimit.remaining,
      node: res.headers.get('x-kyara-node'),
    });
    return res;
  }

  private observeRateLimit(res: TransportResponse): void {
    const num = (h: string): number | null => {
      const v = res.headers.get(h);
      const n = v === null ? NaN : Number(v);
      return Number.isFinite(n) ? n : null;
    };
    const limit = num('x-ratelimit-limit');
    const remaining = num('x-ratelimit-remaining');
    const reset = num('x-ratelimit-reset');
    if (limit !== null) this.rateLimit.limit = limit;
    if (remaining !== null) this.rateLimit.remaining = remaining;
    if (reset !== null) this.rateLimit.resetAt = this.clock.now() + reset * 1000;
  }

  private parse<S extends z.ZodType>(path: string, schema: S, res: TransportResponse): z.infer<S> {
    const json = safeJson(res.text);
    if (json === INVALID_JSON) throw new SchemaMismatchError(path, 'response is not JSON');
    const result = schema.safeParse(json);
    if (!result.success) {
      const issues = result.error.issues
        .slice(0, 5)
        .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
        .join('; ');
      throw new SchemaMismatchError(path, issues);
    }
    return result.data;
  }
}

const INVALID_JSON = Symbol('invalid-json');
function safeJson(text: string): unknown {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return INVALID_JSON;
  }
}

function retryAfterMs(res: TransportResponse, nowMs: number): number | null {
  const ra = res.headers.get('retry-after');
  if (ra) {
    const secs = Number(ra);
    if (Number.isFinite(secs)) return secs * 1000;
    const at = Date.parse(ra);
    if (!Number.isNaN(at)) return Math.max(0, at - nowMs);
  }
  const reset = Number(res.headers.get('x-ratelimit-reset'));
  return Number.isFinite(reset) && reset > 0 ? reset * 1000 : null;
}
