import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { KyaraHttpClient, buildQuery } from '../src/api/KyaraHttpClient.js';
import {
  AuthRequiredError,
  KyaraApiError,
  NetworkError,
  RateLimitedError,
  SchemaMismatchError,
} from '../src/utils/errors.js';
import { createLogger } from '../src/utils/logger.js';
import { MockTransport } from './helpers.js';

function client(t: MockTransport, token: string | null = 'secret-token-1234567890', extra: Partial<ConstructorParameters<typeof KyaraHttpClient>[0]> = {}) {
  const sleeps: number[] = [];
  const onUnauthorized = vi.fn();
  const c = new KyaraHttpClient({
    baseUrl: 'https://kyara.test',
    transport: t,
    credentials: { getToken: () => token, getDeviceId: () => 'device-1', onUnauthorized },
    maxRetries: 3,
    minIntervalMs: 0,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    random: () => 0.5,
    ...extra,
  });
  return { c, sleeps, onUnauthorized };
}

const Ok = z.object({ ok: z.boolean() });

describe('buildQuery', () => {
  it('skips empty values and encodes', () => {
    expect(buildQuery({ a: 1, b: undefined, c: null, d: '', q: 'gojo satoru', t: true })).toBe('?a=1&q=gojo+satoru&t=true');
    expect(buildQuery({})).toBe('');
    expect(buildQuery(undefined)).toBe('');
  });
});

describe('KyaraHttpClient', () => {
  it('sends device id always and bearer token only when auth is requested', async () => {
    const t = new MockTransport().on('GET /a', { body: { ok: true } }).on('GET /b', { body: { ok: true } });
    const { c } = client(t);
    await c.get('/a', Ok);
    await c.get('/b', Ok, { auth: 'optional', query: { x: 1 } });
    expect(t.requests[0]!.headers['x-device-id']).toBe('device-1');
    expect(t.requests[0]!.headers.authorization).toBeUndefined();
    expect(t.requests[1]!.headers.authorization).toBe('Bearer secret-token-1234567890');
    expect(t.requests[1]!.url).toBe('https://kyara.test/api/b?x=1');
  });

  it('throws AuthRequiredError without a token for required auth, without sending', async () => {
    const t = new MockTransport();
    const { c } = client(t, null);
    await expect(c.get('/me', Ok, { auth: 'required' })).rejects.toBeInstanceOf(AuthRequiredError);
    expect(t.requests).toHaveLength(0);
  });

  it('maps 401 to AuthRequiredError and invalidates the session', async () => {
    const t = new MockTransport().on('GET /me', { status: 401, body: { error: 'unauthorized', message: 'Connexion requise' } });
    const { c, onUnauthorized } = client(t);
    await expect(c.get('/me', Ok, { auth: 'required' })).rejects.toBeInstanceOf(AuthRequiredError);
    expect(onUnauthorized).toHaveBeenCalledOnce();
    expect(t.requests).toHaveLength(1);
  });

  it('honours retry-after on 429 then succeeds', async () => {
    const t = new MockTransport().on('GET /x', { status: 429, body: { error: 'rate_limited' }, headers: { 'retry-after': '7' } }, { body: { ok: true } });
    const { c, sleeps } = client(t);
    await expect(c.get('/x', Ok)).resolves.toEqual({ ok: true });
    expect(sleeps).toContain(7000);
  });

  it('gives up with RateLimitedError after max retries', async () => {
    const t = new MockTransport().on('GET /x', { status: 429, body: { error: 'rate_limited' }, headers: { 'x-ratelimit-reset': '2' } });
    const { c } = client(t);
    await expect(c.get('/x', Ok)).rejects.toBeInstanceOf(RateLimitedError);
    expect(t.requests).toHaveLength(4);
  });

  it('does not wait absurdly long on 429', async () => {
    const t = new MockTransport().on('GET /x', { status: 429, body: { error: 'rate_limited' }, headers: { 'retry-after': '3600' } });
    const { c } = client(t);
    await expect(c.get('/x', Ok)).rejects.toBeInstanceOf(RateLimitedError);
    expect(t.requests).toHaveLength(1);
  });

  it('retries GET on 503 catalog_loading and on network errors with bounded backoff', async () => {
    const t = new MockTransport()
      .on('GET /c', { status: 503, body: { error: 'catalog_loading' } }, { body: { ok: true } })
      .on('GET /n', { fail: 'network' }, { fail: 'timeout' }, { body: { ok: true } });
    const { c, sleeps } = client(t);
    await expect(c.get('/c', Ok)).resolves.toEqual({ ok: true });
    await expect(c.get('/n', Ok)).resolves.toEqual({ ok: true });
    expect(sleeps).toEqual([1500, 1000, 2000]);
  });

  it('does not retry 4xx errors and exposes the server code', async () => {
    const t = new MockTransport().on('GET /bad', { status: 400, body: { error: 'bad_request', message: 'pageSize must not be greater than 50' } });
    const { c } = client(t);
    const err = await c.get('/bad', Ok).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(KyaraApiError);
    expect((err as KyaraApiError).code).toBe('bad_request');
    expect((err as KyaraApiError).message).toContain('pageSize');
    expect(t.requests).toHaveLength(1);
  });

  it('never retries mutations, even on 502 or network errors', async () => {
    const t = new MockTransport().on('POST /m', { status: 502, body: { error: 'http_502' } }).on('POST /n', { fail: 'network' });
    const { c } = client(t);
    await expect(c.mutate('POST', '/m', Ok, { body: {} })).rejects.toBeInstanceOf(KyaraApiError);
    await expect(c.mutate('POST', '/n', Ok, { body: {} })).rejects.toBeInstanceOf(NetworkError);
    expect(t.calls('POST /m')).toHaveLength(1);
    expect(t.calls('POST /n')).toHaveLength(1);
  });

  it('sends JSON bodies for mutations', async () => {
    const t = new MockTransport().on('POST /m', { body: { ok: true } });
    const { c } = client(t);
    await c.mutate('POST', '/m', Ok, { body: { maxAmount: 5 }, headers: { 'x-request-id': 'abc' } });
    const r = t.requests[0]!;
    expect(r.body).toBe('{"maxAmount":5}');
    expect(r.headers['content-type']).toBe('application/json');
    expect(r.headers['x-request-id']).toBe('abc');
  });

  it('reports schema mismatches with the path', async () => {
    const t = new MockTransport().on('GET /s', { body: { ok: 'yes' } });
    const { c } = client(t);
    const err = await c.get('/s', Ok).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SchemaMismatchError);
    expect((err as Error).message).toContain('/s');
  });

  it('pauses proactively when the rate-limit window is almost exhausted', async () => {
    const t = new MockTransport().on('GET /r', { body: { ok: true }, headers: { 'x-ratelimit-limit': '2000', 'x-ratelimit-remaining': '10', 'x-ratelimit-reset': '30' } });
    const { c, sleeps } = client(t);
    await c.get('/r', Ok);
    expect(c.rateLimit).toMatchObject({ limit: 2000, remaining: 10 });
    await c.get('/r', Ok);
    expect(sleeps.some((s) => s > 25_000 && s <= 30_000)).toBe(true);
  });

  it('spaces requests by minIntervalMs', async () => {
    const t = new MockTransport().on('GET /a', { body: { ok: true } });
    const { c, sleeps } = client(t, null, { minIntervalMs: 500 });
    await c.get('/a', Ok);
    await c.get('/a', Ok);
    expect(sleeps.length).toBe(1);
    expect(sleeps[0]).toBeGreaterThan(400);
  });

  it('never logs the token', async () => {
    const lines: string[] = [];
    const logger = createLogger({ level: 'debug', sink: (l) => lines.push(l) });
    const t = new MockTransport().on('GET /me', { status: 503, body: { error: 'http_503' } }, { body: { ok: true } });
    const { c } = client(t, 'super-secret-token-xyz', { logger });
    await c.get('/me', Ok, { auth: 'required' });
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.join('\n')).not.toContain('super-secret-token-xyz');
  });
});
