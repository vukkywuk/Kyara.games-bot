import { describe, expect, it } from 'vitest';
import { canonicalString, hmacHex, normalizePairingCode, sha256Hex, signRequest, tokenFingerprint } from '../src/bridge/protocol.js';
import { fingerprint } from '../src/auth/SessionStore.js';
import { HEARTBEAT_MS, planSync } from '../extension/src/syncPolicy.js';
import type { SyncMemory } from '../extension/src/syncPolicy.js';
import { describeState } from '../extension/src/popupModel.js';
import type { PopupState } from '../extension/src/messages.js';

const NOW = 1_800_000_000_000;
const snap = (o: Partial<{ token: string | null; deviceId: string | null; pass: { pass: string; expiresAt: number } | null }> = {}) => ({
  token: 'tok-123456789',
  deviceId: 'device-123456789',
  pass: { pass: 'pass-1', expiresAt: NOW + 20 * 60_000 },
  ...o,
});

describe('bridge protocol', () => {
  it('fingerprints tokens identically in the extension (WebCrypto) and the server (node:crypto)', async () => {
    expect(await tokenFingerprint('some-token-value')).toBe(fingerprint('some-token-value'));
  });

  it('signs a canonical string bound to method, path, time, nonce and body', async () => {
    const secret = Buffer.alloc(32, 1).toString('base64');
    const h = await signRequest('client-1', secret, 'post', '/bridge/sync', '{"a":1}', NOW);
    expect(h['x-kyara-ts']).toBe(String(NOW));
    const expected = await hmacHex(secret, canonicalString('POST', '/bridge/sync', String(NOW), h['x-kyara-nonce']!, await sha256Hex('{"a":1}')));
    expect(h['x-kyara-sig']).toBe(expected);
    const other = await signRequest('client-1', secret, 'POST', '/bridge/sync', '{"a":1}', NOW);
    expect(other['x-kyara-nonce']).not.toBe(h['x-kyara-nonce']);
  });

  it('normalises pairing codes typed by people', () => {
    expect(normalizePairingCode('abcd efgh')).toBe('ABCD-EFGH');
    expect(normalizePairingCode(' ab-cd-ef-gh ')).toBe('ABCD-EFGH');
  });
});

describe('extension sync policy', () => {
  const mem = (o: Partial<SyncMemory> = {}): SyncMemory => ({ tokenFp: 'fp-a', passFp: 'pfp-1', deviceId: 'device-123456789', loggedOut: false, at: NOW - 1000, ...o });

  it('sends everything except the token on first contact', () => {
    const p = planSync(snap(), 'fp-a', 'pfp-1', null, NOW);
    expect(p.send).toBe(true);
    expect(p.reason).toBe('first');
    expect(p.body).toEqual({ tokenFp: 'fp-a', deviceId: 'device-123456789', pass: snap().pass });
    expect(p.body).not.toHaveProperty('token');
  });

  it('does not resend an unchanged pass', () => {
    expect(planSync(snap(), 'fp-a', 'pfp-1', mem(), NOW).send).toBe(false);
  });

  it('sends a rotated pass, and a status-only heartbeat when idle long enough', () => {
    const rotated = planSync(snap({ pass: { pass: 'pass-2', expiresAt: NOW + 29 * 60_000 } }), 'fp-a', 'pfp-2', mem(), NOW);
    expect(rotated).toMatchObject({ send: true, reason: 'pass-changed' });
    expect(rotated.body.pass?.pass).toBe('pass-2');
    const beat = planSync(snap(), 'fp-a', 'pfp-1', mem({ at: NOW - HEARTBEAT_MS }), NOW);
    expect(beat).toMatchObject({ send: true, reason: 'heartbeat' });
    expect(beat.body).not.toHaveProperty('pass');
  });

  it('never sends an expired pass', () => {
    const p = planSync(snap({ pass: { pass: 'old', expiresAt: NOW + 30_000 } }), 'fp-a', 'pfp-9', null, NOW);
    expect(p.body).not.toHaveProperty('pass');
  });

  it('reports logout without any material', () => {
    const p = planSync(snap({ token: null, pass: null }), null, null, mem(), NOW);
    expect(p).toMatchObject({ send: true, reason: 'logged-out', body: { tokenFp: null, loggedOut: true } });
    expect(p.body).not.toHaveProperty('pass');
    expect(p.body).not.toHaveProperty('deviceId');
  });

  it('detects a different account (token change)', () => {
    expect(planSync(snap(), 'fp-b', 'pfp-1', mem(), NOW).reason).toBe('token-changed');
  });
});

describe('popup model', () => {
  const base: PopupState = {
    bridge: 'connected',
    port: 47321,
    label: 'Chrome',
    pairedAt: '2026-10-10T00:00:00Z',
    kyaraTab: { seenAt: NOW - 5000, loggedIn: true, passExpiresAt: NOW + 20 * 60_000, visible: true },
    lastSyncAt: NOW - 30_000,
    lastCheckAt: NOW,
    lastError: null,
    problems: [],
    bot: { hasToken: true, tokenMatches: true, pseudo: 'vukh', passValidForMs: 20 * 60_000 },
  };

  it('shows a healthy paired state in plain words', () => {
    const v = describeState(base, NOW);
    expect(v.rows.map((r) => [r.label, r.value, r.tone])).toEqual([
      ['Bot', 'Connected on port 47321', 'ok'],
      ['Kyara tab', 'Open and logged in', 'ok'],
      ['Pack pass', 'Valid for 20 min', 'ok'],
      ['Bot session', 'Logged in as vukh', 'ok'],
      ['Last sync', '30s ago', 'ok'],
    ]);
    expect(v.note).toBeNull();
  });

  it('explains what to do when the tab is hidden and the pass is about to expire', () => {
    const v = describeState({ ...base, kyaraTab: { ...base.kyaraTab, visible: false, passExpiresAt: NOW + 3 * 60_000 } }, NOW);
    expect(v.note).toContain('Bring the tab to the front');
  });

  it('flags an unreachable bot and an account mismatch', () => {
    expect(describeState({ ...base, bridge: 'unreachable' }, NOW).rows[0]).toMatchObject({ value: 'Not reachable on port 47321', tone: 'bad' });
    expect(describeState({ ...base, bot: { ...base.bot!, tokenMatches: false } }, NOW).rows[3]).toMatchObject({ value: 'Different account than this tab', tone: 'warn' });
  });

  it('never renders secrets (the state type carries none)', () => {
    expect(JSON.stringify(describeState(base, NOW))).not.toMatch(/tok-|pass-1/);
  });
});
