import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { SessionStore } from '../src/auth/SessionStore.js';
import { loadConfig } from '../src/config/config.js';
import { computeStats, joinCollection } from '../src/modules/CollectionModule.js';
import { diffCollections } from '../src/services/CollectionTracker.js';
import { redact, redactString, registerSecret } from '../src/utils/redact.js';
import { UsageError } from '../src/utils/errors.js';
import { parseDuration, parseRarities } from '../src/cli/output.js';
import type { Character } from '../src/api/schemas/common.js';
import { ME, MockTransport, fixture, makeBot, tempDir } from './helpers.js';

describe('SessionStore', () => {
  it('creates a device id, persists the token privately, and invalidates on demand', () => {
    const file = path.join(tempDir(), 's', 'session.json');
    const s = new SessionStore(file);
    const dev = s.deviceId();
    expect(dev).toMatch(/[0-9a-f-]{36}/);
    expect(s.token()).toBeNull();
    s.update({ token: 'tok-1234567890', source: 'browser' });
    const again = new SessionStore(file);
    expect(again.token()).toBe('tok-1234567890');
    expect(again.deviceId()).toBe(dev);
    again.markInvalid();
    expect(new SessionStore(file).token()).toBeNull();
    again.clear();
    expect(new SessionStore(file).load()).toMatchObject({ token: null, deviceId: dev });
  });

  it('prefers an env token and never writes it', () => {
    const file = path.join(tempDir(), 'session.json');
    const s = new SessionStore(file, 'env-token-1234567890');
    expect(s.token()).toBe('env-token-1234567890');
    expect(s.tokenSource()).toBe('env');
    s.deviceId();
    expect(fs.readFileSync(file, 'utf8')).not.toContain('env-token-1234567890');
  });
});

describe('SessionManager', () => {
  it('status reports a rejected token, and import validates against /me', async () => {
    const t = new MockTransport().on('GET /me', { status: 401, body: { error: 'unauthorized' } });
    const { bot } = makeBot(t, { token: null });
    bot.store.update({ token: 'stored-token-123456', source: 'manual' });
    const st = await bot.session.status();
    expect(st.valid).toBe(false);
    await expect(bot.session.importToken('bad-token-123456')).rejects.toThrow();

    const ok = new MockTransport().on('GET /me', { body: ME });
    const { bot: b2 } = makeBot(ok, { token: null });
    const me = await b2.session.importToken('"good-token-123456"\n');
    expect(me.id).toBe(ME.id);
    expect(b2.store.token()).toBe('good-token-123456');
    expect(ok.requests[0]!.headers.authorization).toBe('Bearer good-token-123456');
  });

  it('logout revokes server-side and clears the local token', async () => {
    const t = new MockTransport().on('POST /auth/logout', { body: null });
    const { bot } = makeBot(t, { token: null });
    bot.store.update({ token: 'stored-token-123456', source: 'browser' });
    const r = await bot.session.logout();
    expect(r.revoked).toBe(true);
    expect(bot.store.token()).toBeNull();
  });

  it('refuses browser login in headless mode', async () => {
    const { bot } = makeBot(new MockTransport(), { token: null, env: { KYARA_HEADLESS: 'true' } });
    await expect(bot.session.loginWithBrowser()).rejects.toBeInstanceOf(UsageError);
  });
});

describe('redaction', () => {
  it('masks bearer tokens, query tokens, JWTs, secret keys and registered values', () => {
    registerSecret('my-registered-secret-value');
    expect(redactString('Authorization: Bearer abc.def.ghi')).toBe('Authorization: Bearer [REDACTED]');
    expect(redactString('/api/me/events?token=abcdef123&x=1')).toBe('/api/me/events?token=[REDACTED]&x=1');
    expect(redactString('eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U')).toBe('[REDACTED_JWT]');
    expect(redactString('value my-registered-secret-value here')).toBe('value [REDACTED] here');
    expect(redact({ token: 'x', nested: { 'x-pass': 'y', ok: 1 }, authorization: null })).toEqual({ token: '[REDACTED]', nested: { 'x-pass': '[REDACTED]', ok: 1 }, authorization: null });
  });
});

describe('config', () => {
  it('applies defaults and validates', () => {
    const c = loadConfig({}, '/tmp/x');
    expect(c.baseUrl).toBe('https://kyara.games');
    expect(c.headless).toBe(false);
    expect(c.autoBid.enabled).toBe(false);
    expect(() => loadConfig({ KYARA_TIMEOUT_MS: '5' })).toThrow(UsageError);
    expect(() => loadConfig({ KYARA_HEADLESS: 'maybe' })).toThrow(UsageError);
  });
});

describe('collection', () => {
  const all = fixture<Character[]>('characters.json');
  const entries = [
    { characterId: all[0]!.id, qty: 3, listable: 2 },
    { characterId: all[1]!.id, qty: 1 },
    { characterId: 999_999_999, qty: 1 },
  ];
  it('joins with the catalogue and filters duplicates', () => {
    const byId = new Map(all.map((c) => [c.id, c]));
    expect(joinCollection(entries, byId, { duplicatesOnly: true }).map((o) => o.characterId)).toEqual([all[0]!.id]);
    expect(joinCollection(entries, byId).find((o) => o.characterId === 999_999_999)?.character).toBeNull();
  });
  it('computes completion and duplicate recycle value', () => {
    const s = computeStats(entries, all, fixture<{ recycle: Record<string, number> }>('config.json').recycle);
    expect(s.unique).toBe(3);
    expect(s.copies).toBe(5);
    expect(s.duplicates).toBe(2);
    expect(s.duplicateRecycleValue).toBe(2 * 150); // first fixture character is Mythic (150 each)
  });
  it('diffs snapshots', () => {
    const d = diffCollections(
      { takenAt: 'a', entries: [{ characterId: 1, qty: 1 }, { characterId: 2, qty: 2 }] },
      { takenAt: 'b', entries: [{ characterId: 2, qty: 1 }, { characterId: 3, qty: 1 }] },
    );
    expect(d).toEqual({ from: 'a', to: 'b', added: [{ characterId: 3, qty: 1 }], removed: [{ characterId: 1, qty: 1 }], changed: [{ characterId: 2, before: 2, after: 1 }] });
  });
});

describe('cli parsing helpers', () => {
  it('parses durations and rarities', () => {
    expect(parseDuration('90s')).toBe(90_000);
    expect(parseDuration('5m')).toBe(300_000);
    expect(parseDuration('2h')).toBe(7_200_000);
    expect(() => parseDuration('soon')).toThrow(UsageError);
    expect(parseRarities('l, m')).toEqual(['L', 'M']);
    expect(() => parseRarities('Z')).toThrow(UsageError);
  });
});
