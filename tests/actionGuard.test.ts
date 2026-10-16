import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { TransportFailure } from '../src/api/transport.js';
import { ActionGuard, isAmbiguous } from '../src/services/ActionGuard.js';
import type { ActionSpec } from '../src/services/ActionGuard.js';
import { ActionJournal } from '../src/services/ActionJournal.js';
import {
  ActionRefusedError,
  AmbiguousOutcomeError,
  AuthRequiredError,
  KyaraApiError,
  NetworkError,
  RateLimitedError,
  SchemaMismatchError,
} from '../src/utils/errors.js';
import { silentLogger } from '../src/utils/logger.js';
import { tempDir } from './helpers.js';

function setup(maxSpend = 1000) {
  const dir = tempDir();
  const journal = new ActionJournal(path.join(dir, 'actions.jsonl'));
  const guard = new ActionGuard(journal, silentLogger, maxSpend, path.join(dir, 'action.lock'));
  return { dir, journal, guard };
}

function spec(over: Partial<ActionSpec<{ ok: boolean }>> = {}): ActionSpec<{ ok: boolean }> {
  return {
    kind: 'test.act',
    key: 'test.act:1',
    summary: 'do the thing',
    cost: 10,
    params: {},
    confirm: true,
    execute: vi.fn(async () => ({ ok: true })),
    summarize: (r) => ({ ok: r.ok }),
    ...over,
  };
}

const reason = async (p: Promise<unknown>) => ((await p.catch((e: unknown) => e)) as ActionRefusedError).reason;

describe('ActionGuard', () => {
  it('requires confirmation and sends nothing when declined', async () => {
    const { guard, journal } = setup();
    const s = spec();
    expect(await reason(guard.run(s, { confirm: async () => false }))).toBe('not_confirmed');
    expect(await reason(guard.run(s, {}))).toBe('not_confirmed'); // no prompt available = refuse
    expect(s.execute).not.toHaveBeenCalled();
    expect(journal.list()).toHaveLength(0);
  });

  it('runs and records on confirmation', async () => {
    const { guard, journal } = setup();
    const confirm = vi.fn(async () => true);
    const out = await guard.run(spec(), { confirm });
    expect(out.status).toBe('succeeded');
    expect(confirm).toHaveBeenCalledWith('do the thing');
    expect(journal.list()[0]).toMatchObject({ status: 'succeeded', result: { ok: true } });
  });

  it('dry-run runs checks but never executes', async () => {
    const { guard } = setup();
    const s = spec({ preflight: vi.fn(async () => undefined) });
    const out = await guard.run(s, { dryRun: true });
    expect(out).toEqual({ status: 'dry-run', summary: 'do the thing', cost: 10 });
    expect(s.preflight).toHaveBeenCalled();
    expect(s.execute).not.toHaveBeenCalled();
  });

  it('enforces the per-action budget, including costs discovered in preflight', async () => {
    const { guard } = setup(100);
    expect(await reason(guard.run(spec({ cost: 500 }), { assumeYes: true }))).toBe('over_budget');
    let cost = 0;
    const s = spec({
      preflight: async () => {
        cost = 250;
      },
    });
    // a getter, like the modules use, so the cost can be set during preflight
    Object.defineProperty(s, 'cost', { get: () => cost });
    expect(await reason(guard.run(s, { assumeYes: true }))).toBe('over_budget');
    expect(s.execute).not.toHaveBeenCalled();
    expect((await guard.run(spec({ cost: 500 }), { assumeYes: true, forceBudget: true })).status).toBe('succeeded');
  });

  it('propagates preflight refusals (e.g. insufficient funds) without executing', async () => {
    const { guard, journal } = setup();
    const s = spec({
      preflight: async () => {
        throw new ActionRefusedError('Not enough chakra', 'insufficient_funds');
      },
    });
    expect(await reason(guard.run(s, { assumeYes: true }))).toBe('insufficient_funds');
    expect(s.execute).not.toHaveBeenCalled();
    expect(journal.list()).toHaveLength(0);
  });

  it('refuses a duplicate within the repeat cooldown', async () => {
    const { guard } = setup();
    await guard.run(spec({ repeatCooldownMs: 60_000 }), { assumeYes: true });
    expect(await reason(guard.run(spec({ repeatCooldownMs: 60_000 }), { assumeYes: true }))).toBe('duplicate');
    // different intent key is fine
    expect((await guard.run(spec({ key: 'test.act:2', repeatCooldownMs: 60_000 }), { assumeYes: true })).status).toBe('succeeded');
  });

  it('refuses concurrent identical actions in the same process', async () => {
    const { guard } = setup();
    let release!: () => void;
    const slow = spec({ execute: () => new Promise((r) => (release = () => r({ ok: true }))) });
    const first = guard.run(slow, { assumeYes: true });
    await new Promise((r) => setTimeout(r, 10));
    expect(await reason(guard.run(spec(), { assumeYes: true }))).toBe('duplicate');
    release();
    await first;
  });

  it('records ambiguous failures as unknown, does not retry, and blocks repeats until resolved', async () => {
    const { guard, journal } = setup();
    const execute = vi.fn(async () => {
      throw new NetworkError('Request timed out', { cause: new TransportFailure('timeout', 'timeout', false) });
    });
    const err = await guard.run(spec({ execute }), { assumeYes: true }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AmbiguousOutcomeError);
    expect(execute).toHaveBeenCalledOnce();
    const rec = journal.list()[0]!;
    expect(rec.status).toBe('unknown');

    expect(await reason(guard.run(spec(), { assumeYes: true }))).toBe('pending_unknown');
    journal.finish(rec.id, 'failed', { resolvedBy: 'user' });
    expect((await guard.run(spec(), { assumeYes: true })).status).toBe('succeeded');
  });

  it('records definite failures as failed and rethrows them unchanged', async () => {
    const { guard, journal } = setup();
    const apiErr = new KyaraApiError(402, 'chakra', 'Not enough chakra.', '/x');
    const err = await guard.run(spec({ execute: async () => Promise.reject(apiErr) }), { assumeYes: true }).catch((e: unknown) => e);
    expect(err).toBe(apiErr);
    expect(journal.list()[0]!.status).toBe('failed');
    // a definite failure does not block a new attempt
    expect((await guard.run(spec(), { assumeYes: true })).status).toBe('succeeded');
  });

  it('only resumes unknown actions that carry an idempotency key', async () => {
    const { guard, journal } = setup();
    const noKey = journal.begin({ kind: 'test.act', key: 'test.act:1', summary: 's', cost: 0, params: {}, requestId: null });
    journal.finish(noKey.id, 'unknown', {});
    expect(await reason(guard.run(spec(), { assumeYes: true, resume: journal.get(noKey.id) }))).toBe('pending_unknown');

    const { guard: g2, journal: j2 } = setup();
    const withKey = j2.begin({ kind: 'test.act', key: 'test.act:1', summary: 's', cost: 0, params: {}, requestId: 'req-1' });
    j2.finish(withKey.id, 'unknown', {});
    const out = await g2.run(spec({ requestId: 'req-1' }), { assumeYes: true, resume: j2.get(withKey.id) });
    expect(out.status).toBe('succeeded');
    expect(j2.get(withKey.id)!.status).toBe('succeeded');
  });

  it('holds a cross-process lock while executing and cleans it up', async () => {
    const { guard, dir } = setup();
    const lock = path.join(dir, 'action.lock');
    let seen = false;
    await guard.run(spec({ execute: async () => ((seen = fs.existsSync(lock)), { ok: true }) }), { assumeYes: true });
    expect(seen).toBe(true);
    expect(fs.existsSync(lock)).toBe(false);

    fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, at: Date.now() }));
    expect(await reason(guard.run(spec({ key: 'other' }), { assumeYes: true }))).toBe('duplicate');
    fs.writeFileSync(lock, JSON.stringify({ pid: 999_999_999, at: Date.now() - 10 * 60_000 }));
    expect((await guard.run(spec({ key: 'other' }), { assumeYes: true })).status).toBe('succeeded');
  });

  it('persists the journal across instances, redacting secrets', async () => {
    const { guard, dir } = setup();
    await guard.run(spec({ params: { token: 'very-secret-value-123' } }), { assumeYes: true });
    const raw = fs.readFileSync(path.join(dir, 'actions.jsonl'), 'utf8');
    expect(raw).not.toContain('very-secret-value-123');
    expect(new ActionJournal(path.join(dir, 'actions.jsonl')).list()).toHaveLength(1);
  });
});

describe('isAmbiguous', () => {
  it('classifies outcomes', () => {
    expect(isAmbiguous(new NetworkError('x', { cause: new TransportFailure('t', 'timeout', false) }))).toBe(true);
    expect(isAmbiguous(new NetworkError('x', { cause: new TransportFailure('dns', 'network', true) }))).toBe(false);
    expect(isAmbiguous(new KyaraApiError(500, 'http_500', 'x', '/'))).toBe(true);
    expect(isAmbiguous(new KyaraApiError(503, 'maintenance', 'x', '/'))).toBe(false);
    expect(isAmbiguous(new KyaraApiError(400, 'bid_too_low', 'x', '/'))).toBe(false);
    expect(isAmbiguous(new SchemaMismatchError('/', 'bad'))).toBe(true);
    expect(isAmbiguous(new RateLimitedError('x', null))).toBe(false);
    expect(isAmbiguous(new AuthRequiredError())).toBe(false);
    expect(isAmbiguous(new Error('boom'))).toBe(true);
  });
});
