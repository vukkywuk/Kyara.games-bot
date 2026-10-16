import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { HEADERS, signRequest, tokenFingerprint } from '../src/bridge/protocol.js';
import { EventHub } from '../src/server/EventHub.js';
import { KyaraServer } from '../src/server/KyaraServer.js';
import { isAllowedHost, isLoopbackAddress } from '../src/server/http.js';
import { createLogger } from '../src/utils/logger.js';
import { ME, MockTransport, makeBot } from './helpers.js';

const EXT = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop';
const TOKEN = 'browser-token-0123456789abcdef';
const OTHER_TOKEN = 'other-token-0123456789abcdef';

interface Res {
  status: number;
  body: Record<string, unknown>;
  text: string;
}

function request(port: number, method: string, p: string, opts: { headers?: Record<string, string>; body?: string } = {}): Promise<Res> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, method, path: p, headers: { host: `127.0.0.1:${port}`, ...opts.headers } },
      (res) => {
        let text = '';
        res.on('data', (c: Buffer) => (text += c.toString()));
        res.on('end', () => {
          let body: Record<string, unknown> = {};
          try {
            body = text ? (JSON.parse(text) as Record<string, unknown>) : {};
          } catch {
            /* not json */
          }
          resolve({ status: res.statusCode ?? 0, body, text });
        });
      },
    );
    req.on('error', reject);
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

let servers: KyaraServer[] = [];
afterEach(async () => {
  await Promise.all(servers.map((s) => s.stop()));
  servers = [];
});

async function setup(opts: { meStatus?: number } = {}) {
  const t = new MockTransport().on('GET /me', (req) =>
    req.headers.authorization === `Bearer ${TOKEN}` || req.headers.authorization === `Bearer ${OTHER_TOKEN}`
      ? opts.meStatus
        ? { status: opts.meStatus, body: { error: 'unauthorized' } }
        : { body: ME }
      : { status: 401, body: { error: 'unauthorized' } },
  );
  const hub = new EventHub();
  const logger = createLogger({ level: 'debug', sink: (l) => hub.log(l) });
  const { bot, dir } = makeBot(t, { token: null, overrides: { logger } });
  const server = new KyaraServer(bot, hub, { port: 0, webRoot: null, version: 'test' });
  await server.start();
  servers.push(server);
  const port = Number(new URL(server.address).port);
  return { bot, dir, hub, server, port, t };
}

async function pair(s: Awaited<ReturnType<typeof setup>>) {
  const { code } = s.server.bridge.createPairingCode();
  const r = await request(s.port, 'POST', '/bridge/pair', {
    headers: { origin: EXT, 'content-type': 'application/json' },
    body: JSON.stringify({ code: code.toLowerCase().replace('-', ' '), label: 'Test Chrome' }),
  });
  expect(r.status).toBe(200);
  return r.body as { clientId: string; secret: string };
}

async function signed(s: { port: number }, client: { clientId: string; secret: string }, method: string, p: string, body = '', extra: Record<string, string> = {}) {
  const headers = await signRequest(client.clientId, client.secret, method, p, body);
  return request(s.port, method, p, { headers: { origin: EXT, 'content-type': 'application/json', ...headers, ...extra }, body });
}

describe('loopback helpers', () => {
  it('accept only loopback addresses and our Host names', () => {
    expect(isLoopbackAddress('127.0.0.1')).toBe(true);
    expect(isLoopbackAddress('::1')).toBe(true);
    expect(isLoopbackAddress('::ffff:127.0.0.1')).toBe(true);
    expect(isLoopbackAddress('192.168.1.10')).toBe(false);
    expect(isLoopbackAddress(undefined)).toBe(false);
    expect(isAllowedHost('127.0.0.1:47321', 47321)).toBe(true);
    expect(isAllowedHost('localhost:47321', 47321)).toBe(true);
    expect(isAllowedHost('evil.example:47321', 47321)).toBe(false);
    expect(isAllowedHost('127.0.0.1:1', 47321)).toBe(false);
  });
});

describe('bridge pairing', () => {
  it('requires an active code, the extension origin, and the right code; codes are single use', async () => {
    const s = await setup();
    const noCode = await request(s.port, 'POST', '/bridge/pair', { headers: { origin: EXT }, body: JSON.stringify({ code: 'AAAA-BBBB', label: 'x' }) });
    expect(noCode.body).toMatchObject({ error: { code: 'no_pairing' } });

    const { code } = s.server.bridge.createPairingCode();
    const webPage = await request(s.port, 'POST', '/bridge/pair', { headers: { origin: 'https://evil.example' }, body: JSON.stringify({ code, label: 'x' }) });
    expect(webPage.status).toBe(403);
    const wrong = await request(s.port, 'POST', '/bridge/pair', { headers: { origin: EXT }, body: JSON.stringify({ code: 'ZZZZ-ZZZZ', label: 'x' }) });
    expect(wrong.body).toMatchObject({ error: { code: 'bad_code' } });

    const ok = await request(s.port, 'POST', '/bridge/pair', { headers: { origin: EXT }, body: JSON.stringify({ code, label: 'Chrome' }) });
    expect(ok.status).toBe(200);
    expect(ok.body.secret).toMatch(/^[A-Za-z0-9+/=]{40,}$/);
    const reuse = await request(s.port, 'POST', '/bridge/pair', { headers: { origin: EXT }, body: JSON.stringify({ code, label: 'Chrome' }) });
    expect(reuse.status).toBe(401);
    // the secret is stored privately and never listed
    expect(JSON.stringify(s.server.bridge.clients())).not.toContain(String(ok.body.secret));
  });

  it('invalidates the code after 5 wrong attempts', async () => {
    const s = await setup();
    const { code } = s.server.bridge.createPairingCode();
    for (let i = 0; i < 5; i++) {
      await request(s.port, 'POST', '/bridge/pair', { headers: { origin: EXT }, body: JSON.stringify({ code: `WRNG-000${i}`, label: 'x' }) });
    }
    const late = await request(s.port, 'POST', '/bridge/pair', { headers: { origin: EXT }, body: JSON.stringify({ code, label: 'x' }) });
    expect(late.body).toMatchObject({ error: { code: 'no_pairing' } });
  });

  it('rate-limits pairing attempts', async () => {
    const s = await setup();
    const statuses: number[] = [];
    for (let i = 0; i < 12; i++) {
      s.server.bridge.createPairingCode();
      statuses.push((await request(s.port, 'POST', '/bridge/pair', { headers: { origin: EXT }, body: JSON.stringify({ code: 'ABCD-EFGH', label: 'x' }) })).status);
    }
    expect(statuses.slice(-2)).toEqual([429, 429]);
  });
});

describe('bridge authentication', () => {
  it('accepts correctly signed requests and rejects missing, forged, replayed, stale or foreign-origin ones', async () => {
    const s = await setup();
    const c = await pair(s);
    expect((await signed(s, c, 'GET', '/bridge/status')).status).toBe(200);

    expect((await request(s.port, 'GET', '/bridge/status', { headers: { origin: EXT } })).status).toBe(401);
    expect((await signed(s, { ...c, secret: Buffer.alloc(32, 7).toString('base64') }, 'GET', '/bridge/status')).status).toBe(401);
    expect((await signed(s, c, 'GET', '/bridge/status', '', { origin: 'chrome-extension://otherextensionidotherextensionid' })).status).toBe(401);

    const h = await signRequest(c.clientId, c.secret, 'GET', '/bridge/status', '');
    const first = await request(s.port, 'GET', '/bridge/status', { headers: { origin: EXT, ...h } });
    const replay = await request(s.port, 'GET', '/bridge/status', { headers: { origin: EXT, ...h } });
    expect(first.status).toBe(200);
    expect(replay.body).toMatchObject({ error: { code: 'unauthorized', message: 'Replayed request' } });

    const stale = await signRequest(c.clientId, c.secret, 'GET', '/bridge/status', '', Date.now() - 5 * 60_000);
    expect((await request(s.port, 'GET', '/bridge/status', { headers: { origin: EXT, ...stale } })).status).toBe(401);

    // a signature is bound to the path: reusing it on another operation fails
    const forSync = await signRequest(c.clientId, c.secret, 'GET', '/bridge/status', '');
    expect((await request(s.port, 'POST', '/bridge/sync', { headers: { origin: EXT, ...forSync }, body: '{}' })).status).toBe(401);
  });

  it('only exposes the four bridge operations', async () => {
    const s = await setup();
    const c = await pair(s);
    expect((await signed(s, c, 'GET', '/bridge/../app-api/status')).status).not.toBe(200);
    expect((await signed(s, c, 'POST', '/bridge/exec', '{}')).status).toBe(404);
  });
});

describe('bridge session synchronisation', () => {
  it('asks for the token only when needed, validates it with Kyara, then accepts the pass', async () => {
    const s = await setup();
    const c = await pair(s);
    const fp = await tokenFingerprint(TOKEN);
    const pass = { pass: 'pass-value-abcdef123456', expiresAt: Date.now() + 25 * 60_000 };

    const first = await signed(s, c, 'POST', '/bridge/sync', JSON.stringify({ tokenFp: fp, pass, deviceId: 'device-0123456789' }));
    expect(first.body).toMatchObject({ needToken: true, accepted: { token: false, pass: false, device: true } });

    const second = await signed(s, c, 'POST', '/bridge/sync', JSON.stringify({ tokenFp: fp, token: TOKEN, pass }));
    expect(second.body).toMatchObject({ needToken: false, accepted: { token: true, pass: true } });
    expect(s.bot.store.token()).toBe(TOKEN);
    expect(s.bot.store.tokenSource()).toBe('bridge');
    expect(s.bot.passes.cachedPass()).toBe(pass.pass);
    expect(s.bot.store.deviceId()).toBe('device-0123456789');

    // the bridge never echoes session material back
    for (const r of [first, second]) {
      expect(r.text).not.toContain(TOKEN);
      expect(r.text).not.toContain(pass.pass);
    }
    // a newer pass replaces the old one without resending the token
    const newer = { pass: 'pass-value-rotated-999', expiresAt: Date.now() + 29 * 60_000 };
    const third = await signed(s, c, 'POST', '/bridge/sync', JSON.stringify({ tokenFp: fp, pass: newer }));
    expect(third.body).toMatchObject({ needToken: false, accepted: { pass: true } });
    expect(s.bot.passes.cachedPass()).toBe(newer.pass);
  });

  it('rejects a token Kyara refuses and never stores it', async () => {
    const s = await setup();
    const c = await pair(s);
    const bad = 'not-a-valid-token-0000000000';
    const r = await signed(s, c, 'POST', '/bridge/sync', JSON.stringify({ tokenFp: await tokenFingerprint(bad), token: bad }));
    expect(r.body).toMatchObject({ accepted: { token: false }, needToken: false });
    expect((r.body.problems as string[]).join()).toContain('rejected');
    expect(s.bot.store.token()).toBeNull();
  });

  it('refuses a pass that belongs to another session, and expired passes', async () => {
    const s = await setup();
    const c = await pair(s);
    await signed(s, c, 'POST', '/bridge/sync', JSON.stringify({ tokenFp: await tokenFingerprint(TOKEN), token: TOKEN }));
    const foreign = await signed(s, c, 'POST', '/bridge/sync', JSON.stringify({ tokenFp: await tokenFingerprint(OTHER_TOKEN), pass: { pass: 'p-foreign-123456', expiresAt: Date.now() + 600_000 } }));
    expect(foreign.body).toMatchObject({ accepted: { pass: false }, needToken: true });
    const expired = await signed(s, c, 'POST', '/bridge/sync', JSON.stringify({ tokenFp: await tokenFingerprint(TOKEN), pass: { pass: 'p-expired-123456', expiresAt: Date.now() + 10_000 } }));
    expect(expired.body).toMatchObject({ accepted: { pass: false } });
    expect(s.bot.passes.cachedPass()).toBeNull();
  });

  it('logging out in the browser clears the pass and a bridge-provided token', async () => {
    const s = await setup();
    const c = await pair(s);
    const fp = await tokenFingerprint(TOKEN);
    await signed(s, c, 'POST', '/bridge/sync', JSON.stringify({ tokenFp: fp, token: TOKEN, pass: { pass: 'p-live-123456789', expiresAt: Date.now() + 600_000 } }));
    const out = await signed(s, c, 'POST', '/bridge/sync', JSON.stringify({ tokenFp: null, loggedOut: true }));
    expect(out.status).toBe(200);
    expect(s.bot.passes.cachedPass()).toBeNull();
    expect(s.bot.store.token()).toBeNull();
  });

  it('keeps a manually imported token when the browser logs out', async () => {
    const s = await setup();
    const c = await pair(s);
    s.bot.store.update({ token: OTHER_TOKEN, source: 'manual' });
    await signed(s, c, 'POST', '/bridge/sync', JSON.stringify({ tokenFp: null, loggedOut: true }));
    expect(s.bot.store.token()).toBe(OTHER_TOKEN);
  });

  it('rejects malformed and oversized payloads', async () => {
    const s = await setup();
    const c = await pair(s);
    const extra = await signed(s, c, 'POST', '/bridge/sync', JSON.stringify({ tokenFp: null, command: 'rm -rf /' }));
    expect(extra.status).toBe(400);
    const badFp = await signed(s, c, 'POST', '/bridge/sync', JSON.stringify({ tokenFp: 'not-hex' }));
    expect(badFp.status).toBe(400);
    const notJson = await signed(s, c, 'POST', '/bridge/sync', '{oops');
    expect(notJson.status).toBe(400);
    const huge = await signed(s, c, 'POST', '/bridge/sync', JSON.stringify({ tokenFp: null, token: 'x'.repeat(20_000) }));
    expect(huge.status).toBe(413);
  });

  it('serialises concurrent syncs (no torn session state)', async () => {
    const s = await setup();
    const c = await pair(s);
    const fp = await tokenFingerprint(TOKEN);
    await signed(s, c, 'POST', '/bridge/sync', JSON.stringify({ tokenFp: fp, token: TOKEN }));
    const passes = Array.from({ length: 6 }, (_, i) => ({ pass: `p-concurrent-${i}-abcdef`, expiresAt: Date.now() + 600_000 + i }));
    const results = await Promise.all(passes.map((p) => signed(s, c, 'POST', '/bridge/sync', JSON.stringify({ tokenFp: fp, pass: p }))));
    expect(results.every((r) => r.status === 200)).toBe(true);
    const stored = JSON.parse(fs.readFileSync(path.join(s.dir, 'session.json'), 'utf8')) as { pass: { pass: string }; token: string };
    expect(passes.map((p) => p.pass)).toContain(stored.pass.pass);
    expect(stored.token).toBe(TOKEN);
  });

  it('rate-limits synchronisation per client', async () => {
    const s = await setup();
    const c = await pair(s);
    let limited = 0;
    for (let i = 0; i < 62; i++) {
      const r = await signed(s, c, 'POST', '/bridge/sync', JSON.stringify({ tokenFp: null }));
      if (r.status === 429) limited++;
    }
    expect(limited).toBeGreaterThan(0);
  });

  it('never writes session material to the logs or events', async () => {
    const s = await setup();
    const c = await pair(s);
    const fp = await tokenFingerprint(TOKEN);
    const pass = { pass: 'pass-should-never-be-logged-42', expiresAt: Date.now() + 600_000 };
    await signed(s, c, 'POST', '/bridge/sync', JSON.stringify({ tokenFp: fp, token: TOKEN, pass }));
    const dump = JSON.stringify([s.hub.recentLogs(), s.hub.recentEvents()]);
    expect(dump).not.toContain(TOKEN);
    expect(dump).not.toContain(pass.pass);
    expect(dump).not.toContain(c.secret);
  });

  it('unpairing revokes the client immediately', async () => {
    const s = await setup();
    const c = await pair(s);
    expect((await signed(s, c, 'DELETE', '/bridge/pair')).status).toBe(200);
    expect((await signed(s, c, 'GET', '/bridge/status')).status).toBe(401);
  });
});

describe('app API protection', () => {
  it('needs the app token, a same-origin token fetch, our Host, and our Origin for writes', async () => {
    const s = await setup();
    expect((await request(s.port, 'GET', '/app-api/status')).status).toBe(401);
    expect((await request(s.port, 'GET', '/app-api/token', { headers: { 'sec-fetch-site': 'cross-site' } })).status).toBe(403);
    const tok = await request(s.port, 'GET', '/app-api/token', { headers: { 'sec-fetch-site': 'same-origin' } });
    const token = String(tok.body.token);
    const auth = { 'x-kyara-app-token': token };
    expect((await request(s.port, 'GET', '/app-api/status', { headers: auth })).status).toBe(200);
    expect((await request(s.port, 'GET', '/app-api/status', { headers: { ...auth, host: 'attacker.example' } })).status).toBe(421);
    expect((await request(s.port, 'POST', '/app-api/bridge/pairing-code', { headers: auth })).status).toBe(403);
    expect((await request(s.port, 'POST', '/app-api/bridge/pairing-code', { headers: { ...auth, origin: 'https://evil.example' } })).status).toBe(403);
    const ok = await request(s.port, 'POST', '/app-api/bridge/pairing-code', { headers: { ...auth, origin: s.server.address } });
    expect(ok.body.code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    // preflights are refused: no CORS for anyone
    const pre = await request(s.port, 'OPTIONS', '/app-api/status', { headers: { origin: 'https://evil.example', 'access-control-request-method': 'POST' } });
    expect(pre.status).toBe(403);
    expect(pre.text).not.toContain('access-control-allow-origin');
  });

  it('state-changing app calls need an explicit dryRun or confirm', async () => {
    const s = await setup();
    const token = String((await request(s.port, 'GET', '/app-api/token')).body.token);
    const r = await request(s.port, 'POST', '/app-api/progress/claim', {
      headers: { 'x-kyara-app-token': token, origin: s.server.address },
      body: JSON.stringify({ kind: 'all' }),
    });
    expect(r.status).toBe(400);
  });
});

describe('shutdown', () => {
  it('closes the listener and live event streams', async () => {
    const s = await setup();
    const token = String((await request(s.port, 'GET', '/app-api/token')).body.token);
    const streamClosed = new Promise<void>((resolve) => {
      const req = http.request({ host: '127.0.0.1', port: s.port, path: '/app-api/stream', headers: { host: `127.0.0.1:${s.port}`, 'x-kyara-app-token': token } }, (res) => {
        res.on('data', () => undefined);
        res.on('close', () => resolve());
        res.on('end', () => resolve());
      });
      req.on('error', () => resolve());
      req.end();
    });
    await new Promise((r) => setTimeout(r, 50));
    await s.server.stop();
    servers = servers.filter((x) => x !== s.server);
    await streamClosed;
    await expect(request(s.port, 'GET', '/app-api/token')).rejects.toThrow();
  });
});

// keep HEADERS imported for readers: documents the signed header names
void HEADERS;

describe('review regressions', () => {
  it('never switches the bot to another Kyara account silently', async () => {
    const s = await setup();
    const c = await pair(s);
    s.bot.store.update({ token: OTHER_TOKEN, source: 'manual', user: { id: 'someone-else', pseudo: 'alt', discordLinked: true } });
    const fp = await tokenFingerprint(TOKEN);
    const r = await signed(s, c, 'POST', '/bridge/sync', JSON.stringify({ tokenFp: fp, token: TOKEN }));
    expect(r.body).toMatchObject({ accepted: { token: false }, needToken: false });
    expect((r.body.problems as string[]).join()).toContain('Forget the bot');
    expect(s.bot.store.token()).toBe(OTHER_TOKEN);
    // after forgetting the session, the browser's account is adopted
    await s.bot.session.forget();
    const again = await signed(s, c, 'POST', '/bridge/sync', JSON.stringify({ tokenFp: fp, token: TOKEN }));
    expect(again.body).toMatchObject({ accepted: { token: true } });
    expect(s.bot.store.token()).toBe(TOKEN);
  });

  it('web pages cannot exhaust the pairing rate limit', async () => {
    const s = await setup();
    for (let i = 0; i < 15; i++) await request(s.port, 'POST', '/bridge/pair', { headers: { origin: 'https://evil.example' }, body: 'x' });
    const { code } = s.server.bridge.createPairingCode();
    const ok = await request(s.port, 'POST', '/bridge/pair', { headers: { origin: EXT }, body: JSON.stringify({ code, label: 'Chrome' }) });
    expect(ok.status).toBe(200);
  });

  it('two concurrent copies of one signed request: only one passes', async () => {
    const s = await setup();
    const c = await pair(s);
    const h = await signRequest(c.clientId, c.secret, 'GET', '/bridge/status', '');
    const [a, b] = await Promise.all([1, 2].map(() => request(s.port, 'GET', '/bridge/status', { headers: { origin: EXT, ...h } })));
    expect([a!.status, b!.status].sort()).toEqual([200, 401]);
  });

  it('rejects a body that asks for both dryRun and confirm', async () => {
    const s = await setup();
    const token = String((await request(s.port, 'GET', '/app-api/token')).body.token);
    const r = await request(s.port, 'POST', '/app-api/progress/claim', {
      headers: { 'x-kyara-app-token': token, origin: s.server.address },
      body: JSON.stringify({ kind: 'all', dryRun: true, confirm: true }),
    });
    expect(r.status).toBe(400);
  });

  it('only hands the app token to same-origin pages (not "none")', async () => {
    const s = await setup();
    expect((await request(s.port, 'GET', '/app-api/token', { headers: { 'sec-fetch-site': 'none' } })).status).toBe(403);
  });

  it('maps invalid query values to 400 instead of 500', async () => {
    const s = await setup();
    const token = String((await request(s.port, 'GET', '/app-api/token')).body.token);
    const auth = { 'x-kyara-app-token': token };
    expect((await request(s.port, 'GET', '/app-api/market/listings?sort=bogus', { headers: auth })).status).toBe(400);
    expect((await request(s.port, 'GET', '/app-api/leaderboard?by=bogus', { headers: auth })).status).toBe(400);
    expect((await request(s.port, 'GET', '/app-api/characters/%E0%A4%A', { headers: auth })).status).toBe(400);
  });
});

describe('static serving', () => {
  it('serves files, falls back to index.html for app routes and device-like names, and refuses traversal', async () => {
    const t = new MockTransport();
    const { bot, dir } = makeBot(t, { token: null, overrides: { logger: createLogger({ level: 'error', sink: () => undefined }) } });
    const web = path.join(dir, 'web');
    fs.mkdirSync(path.join(web, 'assets'), { recursive: true });
    fs.writeFileSync(path.join(web, 'index.html'), '<!doctype html><title>app</title>');
    fs.writeFileSync(path.join(web, 'assets', 'a.js'), 'console.log(1)');
    const server = new KyaraServer(bot, new EventHub(), { port: 0, webRoot: web, version: 't' });
    await server.start();
    servers.push(server);
    const port = Number(new URL(server.address).port);
    const asset = await request(port, 'GET', '/assets/a.js');
    expect(asset.text).toBe('console.log(1)');
    for (const p of ['/characters', '/aux', '/con.txt', '/nul']) expect((await request(port, 'GET', p)).text).toContain('<title>app</title>');
    expect((await request(port, 'GET', '/..%2f..%2fpackage.json')).status).not.toBe(200);
    expect((await request(port, 'GET', '/%E0%A4%A')).status).toBe(400);
  });
});
