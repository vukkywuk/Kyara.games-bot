import { describe, expect, it, vi } from 'vitest';
import { ActionRefusedError, AmbiguousOutcomeError, HumanVerificationError, KyaraApiError, UsageError } from '../src/utils/errors.js';
import { ME, MockTransport, card, fixture, makeBot, openResult } from './helpers.js';

const packs = fixture('packs.json');
const PROVIDERS = { discord: true, turnstile: '0xSITEKEY' };
const PASS = { pass: 'pass-abcdef-123456', expiresAt: Date.now() + 30 * 60_000 };

function base(me = ME) {
  return new MockTransport()
    .on('GET /packs', { body: packs })
    .on('GET /me', { body: me })
    .on('GET /me/packs', { body: { limits: {} } })
    .on('GET /auth/providers', { body: PROVIDERS })
    .on('POST /auth/pass', { body: PASS });
}

describe('PackModule.open', () => {
  it('opens a free pack without confirmation prompts beyond the guard, sending pass, request id and ceiling', async () => {
    const t = base({ ...ME, freePacks: 3 }).on('POST /packs/all/open', { body: openResult(1000) });
    const { bot } = makeBot(t);
    const out = await bot.packs.open('all', 1, { browserPass: true, assumeYes: true });
    expect(out.status).toBe('succeeded');
    if (out.status !== 'succeeded') return;
    expect(out.result.cards).toHaveLength(2);
    expect(out.result.newCards).toBe(1);
    const req = t.calls('POST /packs/all/open')[0]!;
    expect(req.headers['x-pass']).toBe(PASS.pass);
    expect(req.headers['x-request-id']).toMatch(/^[0-9a-f]{32}$/);
    expect(JSON.parse(req.body!)).toEqual({ maxChakra: 0 });
    expect(t.calls('POST /auth/pass')[0]!.body).toBe('{"turnstile":"turnstile-token"}');
  });

  it('reuses a cached pass instead of asking Cloudflare again', async () => {
    const t = base({ ...ME, freePacks: 5 }).on('POST /packs/all/open', { body: openResult(1000) });
    const { bot } = makeBot(t);
    await bot.packs.open('all', 1, { browserPass: true, assumeYes: true });
    await new Promise((r) => setTimeout(r, 5));
    await bot.packs.open('all', 1, { browserPass: true, assumeYes: true }).catch(() => undefined); // may hit repeat cooldown
    expect(t.calls('POST /auth/pass')).toHaveLength(1);
  });

  it('shows the chakra cost and requires confirmation for paid packs', async () => {
    const t = base({ ...ME, chakra: 1000 }).on('POST /packs/top/open', { body: openResult(250) });
    const { bot } = makeBot(t, { env: { KYARA_MAX_SPEND_PER_ACTION: '5000' } });
    const prompts: string[] = [];
    const refused = await bot.packs.open('top', 1, { browserPass: true, confirm: async (s) => (prompts.push(s), false) }).catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(ActionRefusedError);
    expect(prompts[0]).toContain('cost 750 chakra');
    expect(t.calls('POST /packs/top/open')).toHaveLength(0);
  });

  it('refuses when the balance is insufficient', async () => {
    const t = base({ ...ME, chakra: 100 });
    const { bot } = makeBot(t);
    const err = (await bot.packs.open('top', 1, { browserPass: true, assumeYes: true }).catch((e: unknown) => e)) as ActionRefusedError;
    expect(err.reason).toBe('insufficient_funds');
    expect(t.requests.some((r) => r.method === 'POST')).toBe(false);
  });

  it('refuses above the per-action spend limit unless forced', async () => {
    const t = base({ ...ME, chakra: 100_000 }).on('POST /packs/top/open-many', { body: { results: [openResult(1), openResult(1)] } });
    const { bot } = makeBot(t, { env: { KYARA_MAX_SPEND_PER_ACTION: '1000' } });
    const err = (await bot.packs.open('top', 2, { browserPass: true, assumeYes: true }).catch((e: unknown) => e)) as ActionRefusedError;
    expect(err.reason).toBe('over_budget');
    const ok = await bot.packs.open('top', 2, { browserPass: true, assumeYes: true, forceBudget: true });
    expect(ok.status).toBe('succeeded');
    expect(JSON.parse(t.calls('POST /packs/top/open-many')[0]!.body!)).toEqual({ count: 2, maxChakra: 1500 });
  });

  it('refuses requireFree openings that would cost chakra', async () => {
    const t = base({ ...ME, chakra: 5000, freePacks: 0 });
    const { bot } = makeBot(t);
    const err = (await bot.packs.open('all', 1, { browserPass: true, assumeYes: true, requireFree: true }).catch((e: unknown) => e)) as ActionRefusedError;
    expect(err.reason).toBe('over_budget');
  });

  it('respects daily limits and grant-only packs', async () => {
    const t = base().on('GET /me/packs', { body: { limits: { daily: { left: 0 } } } });
    const { bot } = makeBot(t);
    expect(((await bot.packs.open('daily', 1, { browserPass: true, assumeYes: true }).catch((e: unknown) => e)) as ActionRefusedError).reason).toBe('prerequisite');
    expect(((await bot.packs.open('seal-mythic', 1, { browserPass: true, assumeYes: true }).catch((e: unknown) => e)) as ActionRefusedError).reason).toBe('prerequisite');
  });

  it('renews the pass and re-sends the SAME request id on pass_required', async () => {
    const t = base({ ...ME, freePacks: 1 }).on(
      'POST /packs/all/open',
      { status: 403, body: { error: 'pass_required', message: 'pass' } },
      { body: openResult(1000) },
    );
    const { bot } = makeBot(t);
    const out = await bot.packs.open('all', 1, { browserPass: true, assumeYes: true });
    expect(out.status).toBe('succeeded');
    const [a, b] = t.calls('POST /packs/all/open');
    expect(a!.headers['x-request-id']).toBe(b!.headers['x-request-id']);
    expect(t.calls('POST /auth/pass')).toHaveLength(2);
  });

  it('marks a timed-out opening as unknown, never retries it, and allows resuming with the same id', async () => {
    const t = base({ ...ME, freePacks: 1 }).on('POST /packs/all/open', { fail: 'timeout' }, { body: openResult(1000, [card(9, 'M', { isNew: true })]) });
    const { bot } = makeBot(t);
    const err = (await bot.packs.open('all', 1, { browserPass: true, assumeYes: true }).catch((e: unknown) => e)) as AmbiguousOutcomeError;
    expect(err).toBeInstanceOf(AmbiguousOutcomeError);
    expect(t.calls('POST /packs/all/open')).toHaveLength(1);
    const rec = bot.journal.get(err.actionId)!;
    expect(rec.status).toBe('unknown');

    // A fresh identical command is blocked…
    const blocked = (await bot.packs.open('all', 1, { browserPass: true, assumeYes: true }).catch((e: unknown) => e)) as ActionRefusedError;
    expect(blocked.reason).toBe('pending_unknown');
    // …but resuming re-sends with the recorded idempotency key.
    const resumed = await bot.packs.open('all', 1, { browserPass: true, assumeYes: true, resumeId: rec.id.slice(0, 8) });
    expect(resumed.status).toBe('succeeded');
    const [first, second] = t.calls('POST /packs/all/open');
    expect(second!.headers['x-request-id']).toBe(first!.headers['x-request-id']);
    expect(bot.journal.get(rec.id)!.status).toBe('succeeded');
  });

  it('treats an insufficient-funds answer from the server as a definite failure', async () => {
    const t = base({ ...ME, chakra: 10_000 }).on('POST /packs/top/open', { status: 402, body: { error: 'chakra', message: 'Pas assez' } });
    const { bot } = makeBot(t, { env: { KYARA_MAX_SPEND_PER_ACTION: '5000' } });
    const err = await bot.packs.open('top', 1, { browserPass: true, assumeYes: true }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(KyaraApiError);
    expect(bot.journal.list()[0]!.status).toBe('failed');
  });

  it('reports open-many partial stops', async () => {
    const t = base({ ...ME, freePacks: 10 }).on('POST /packs/all/open-many', {
      body: { results: [openResult(1000), openResult(1000)], stopped: { code: 'guest_limit', message: 'limit' } },
    });
    const { bot } = makeBot(t);
    const out = await bot.packs.open('all', 3, { browserPass: true, assumeYes: true });
    if (out.status !== 'succeeded') throw new Error('expected success');
    expect(out.result.opened).toBe(2);
    expect(out.result.stopped?.code).toBe('guest_limit');
  });
});

describe('imported pack pass', () => {
  const raw = (expiresAt: number) => JSON.stringify({ pass: 'imported-pass-123456', expiresAt });

  it('accepts the kyara_pass JSON (plain or quoted) and uses it without contacting Cloudflare', async () => {
    const t = base({ ...ME, freePacks: 2 }).on('POST /packs/all/open', { body: openResult(1000) });
    const { bot } = makeBot(t, { overrides: { verifier: { turnstileToken: async () => Promise.reject(new Error('must not be called')) } } });
    const exp = Date.now() + 20 * 60_000;
    expect(bot.passes.importPass(JSON.stringify(raw(exp)), 'device-from-browser').expiresAt).toBe(exp);
    expect(bot.store.deviceId()).toBe('device-from-browser');
    await bot.packs.open('all', 1, { browserPass: true, assumeYes: true });
    const req = t.calls('POST /packs/all/open')[0]!;
    expect(req.headers['x-pass']).toBe('imported-pass-123456');
    expect(req.headers['x-device-id']).toBe('device-from-browser');
    expect(t.calls('POST /auth/pass')).toHaveLength(0);
  });

  it('rejects expired or malformed values', async () => {
    const { bot } = makeBot(new MockTransport());
    expect(() => bot.passes.importPass(raw(Date.now() + 10_000))).toThrow(UsageError);
    expect(() => bot.passes.importPass('not json')).toThrow(UsageError);
    expect(() => bot.passes.importPass('{"token":"x"}')).toThrow(UsageError);
  });

  it('when Cloudflare refuses the bot browser, fails cleanly with import instructions and opens nothing', async () => {
    const t = base({ ...ME, freePacks: 2 });
    const { bot } = makeBot(t, {
      overrides: { verifier: { turnstileToken: async () => Promise.reject(new HumanVerificationError('Cloudflare verification failed (turnstile_failed:600010)')) } },
    });
    const err = (await bot.packs.open('all', 1, { browserPass: true, assumeYes: true }).catch((e: unknown) => e)) as Error;
    expect(err).toBeInstanceOf(HumanVerificationError);
    expect(err.message).toContain('session import-pass');
    expect(t.calls('POST /packs/all/open')).toHaveLength(0);
    expect(bot.journal.list()[0]!.status).toBe('failed');
  });
});

describe('pack pass policy', () => {
  it('without a stored pass, refuses BEFORE the confirmation prompt and never opens a browser', async () => {
    const t = base({ ...ME, freePacks: 2 });
    const verifier = { turnstileToken: vi.fn(async () => 'x') };
    const { bot } = makeBot(t, { overrides: { verifier } });
    const confirm = vi.fn(async () => true);
    const err = (await bot.packs.open('all', 1, { confirm }).catch((e: unknown) => e)) as ActionRefusedError;
    expect(err.reason).toBe('prerequisite');
    expect(err.message).toContain('session import-pass');
    expect(confirm).not.toHaveBeenCalled();
    expect(verifier.turnstileToken).not.toHaveBeenCalled();
    expect(bot.journal.list()).toHaveLength(0);
    expect(t.requests.some((r) => r.method === 'POST')).toBe(false);
  });

  it('needs no pass while Kyara has Turnstile off: opens with no x-pass header, as the site does', async () => {
    const t = base({ ...ME, freePacks: 2 })
      .on('GET /auth/providers', { body: { discord: true, turnstile: null } })
      .on('POST /packs/all/open', { body: openResult(1000) });
    const verifier = { turnstileToken: vi.fn(async () => 'x') };
    const { bot } = makeBot(t, { overrides: { verifier } });
    const out = await bot.packs.open('all', 1, { assumeYes: true, requireFree: true });
    expect(out.status).toBe('succeeded');
    expect(t.calls('POST /packs/all/open')[0]!.headers['x-pass']).toBeUndefined();
    expect(verifier.turnstileToken).not.toHaveBeenCalled();
    expect(t.calls('POST /auth/pass')).toHaveLength(0);
  });

  it('dry-run only warns about the missing pass', async () => {
    const { bot } = makeBot(base({ ...ME, freePacks: 2 }));
    expect((await bot.packs.open('all', 1, { dryRun: true })).status).toBe('dry-run');
  });

  it('a stored pass rejected by the server is not renewed through the bot browser', async () => {
    const t = base({ ...ME, freePacks: 2 }).on('POST /packs/all/open', { status: 403, body: { error: 'pass_required' } });
    const verifier = { turnstileToken: vi.fn(async () => 'x') };
    const { bot } = makeBot(t, { overrides: { verifier } });
    bot.passes.importPass(JSON.stringify({ pass: 'stale-pass-123456', expiresAt: Date.now() + 600_000 }));
    const err = (await bot.packs.open('all', 1, { assumeYes: true }).catch((e: unknown) => e)) as Error;
    expect(err).toBeInstanceOf(HumanVerificationError);
    expect(verifier.turnstileToken).not.toHaveBeenCalled();
    expect(bot.passes.cachedPass()).toBeNull();
  });

  it('a resume that fails before sending keeps the original action unknown', async () => {
    const t = base({ ...ME, freePacks: 2 }).on('POST /packs/all/open', { fail: 'timeout' });
    const { bot } = makeBot(t);
    bot.passes.importPass(JSON.stringify({ pass: 'pass-1234567890', expiresAt: Date.now() + 600_000 }));
    const amb = (await bot.packs.open('all', 1, { assumeYes: true }).catch((e: unknown) => e)) as AmbiguousOutcomeError;
    expect(bot.journal.get(amb.actionId)!.status).toBe('unknown');
    // the resend is refused (pass_required): that says nothing about the first attempt → still unknown
    t.on('POST /packs/all/open', { status: 403, body: { error: 'pass_required' } });
    await bot.packs.open('all', 1, { assumeYes: true, resumeId: amb.actionId }).catch(() => undefined);
    expect(bot.journal.get(amb.actionId)!.status).toBe('unknown');
  });
});
