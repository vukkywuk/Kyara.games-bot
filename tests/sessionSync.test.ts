import { describe, expect, it } from 'vitest';
import { ME, MockTransport, makeBot } from './helpers.js';

const GUEST_TOKEN = 'guest-token-0123456789abcdef';
const REAL_TOKEN = 'real-token-0123456789abcdef';
const GUEST = { ...ME, id: '00000000-0000-4000-8000-00000000bbbb', pseudo: 'Invite-A7503B', discord: null };
const REAL = { ...ME, id: '00000000-0000-4000-8000-00000000cccc', pseudo: 'vukh', discord: { avatar: null } };

function setup() {
  const t = new MockTransport().on('GET /me', (req) => ({ body: req.headers.authorization === `Bearer ${GUEST_TOKEN}` ? GUEST : REAL }));
  return { t, ...makeBot(t, { token: null }) };
}
const snap = (token: string | null) => ({ token, deviceId: null, pass: { pass: 'pass-0123456789abcdef', expiresAt: Date.now() + 20 * 60_000 } });

describe('session sync from the app window / extension', () => {
  it('never adopts the guest account Kyara creates before you log in', async () => {
    const { bot, t } = setup();
    const res = await bot.session.applySiteSnapshot(snap(GUEST_TOKEN));
    expect(res.accepted.token).toBe(false);
    expect(res.problems.join()).toMatch(/guest account/);
    expect(bot.http.hasToken()).toBe(false);
    // not re-checked with Kyara on every pass renewal
    await bot.session.applySiteSnapshot(snap(GUEST_TOKEN));
    expect(t.calls('GET /me')).toHaveLength(1);
  });

  it('then takes the real account as soon as you log in with Discord, with its pass', async () => {
    const { bot } = setup();
    await bot.session.applySiteSnapshot(snap(GUEST_TOKEN));
    const res = await bot.session.applySiteSnapshot(snap(REAL_TOKEN));
    expect(res.accepted).toMatchObject({ token: true, pass: true });
    expect(bot.store.load().user?.pseudo).toBe('vukh');
    expect(bot.passes.cachedPass()).not.toBeNull();
  });

  it('replaces a guest session adopted by an older version instead of refusing the real account', async () => {
    const { bot } = setup();
    bot.store.update({ token: GUEST_TOKEN, source: 'app', user: { id: GUEST.id, pseudo: GUEST.pseudo, discordLinked: false } });
    const res = await bot.session.applySiteSnapshot(snap(REAL_TOKEN));
    expect(res.accepted.token).toBe(true);
    expect(bot.store.load().user?.id).toBe(REAL.id);
  });

  it('still refuses to switch silently between two real accounts', async () => {
    const { bot } = setup();
    bot.store.update({ token: 'other-real-token-0123456789', source: 'app', user: { id: '00000000-0000-4000-8000-00000000dddd', pseudo: 'other', discordLinked: true } });
    const res = await bot.session.applySiteSnapshot(snap(REAL_TOKEN));
    expect(res.accepted.token).toBe(false);
    expect(res.problems.join()).toMatch(/Forget the bot's session/);
  });
});
