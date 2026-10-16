import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Browser, Page } from 'playwright';
import { EventHub } from '../src/server/EventHub.js';
import { KyaraServer } from '../src/server/KyaraServer.js';
import { silentLogger } from '../src/utils/logger.js';
import { ME, MockTransport, card, fixture, makeBot, openResult } from './helpers.js';

/**
 * Opt-in (KYARA_BROWSER_TESTS=1): the built web app + the real local server, with Kyara
 * MOCKED (no request reaches kyara.games, nothing is spent). Checks every screen renders
 * without console errors and that state-changing flows behave safely.
 */
const enabled = process.env.KYARA_BROWSER_TESTS === '1';
const ROOT = path.resolve(import.meta.dirname, '..');
const LISTING_ID = '11111111-2222-4333-8444-555555555555';
const TRADE_ID = '33333333-2222-4333-8444-555555555555';
const OTHER = { id: '44444444-2222-4333-8444-555555555555', pseudo: 'Alolo' };
const SHOTS = process.env.KYARA_SHOTS; // optional folder for visual QA screenshots

describe.skipIf(!enabled)('web app smoke test (Kyara mocked)', () => {
  let server: KyaraServer;
  let browser: Browser;
  let page: Page;
  let t: MockTransport;
  let base = '';
  const errors: string[] = [];

  beforeAll(async () => {
    execFileSync(process.execPath, [path.join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js'), 'build', '--config', 'web/vite.config.ts', '--logLevel', 'error'], { cwd: ROOT, stdio: 'ignore' });
    const listings = fixture<{ items: Array<Record<string, unknown>>; total: number }>('listings.json');
    const future = (ms: number) => new Date(Date.now() + ms).toISOString();
    const items: Array<Record<string, unknown>> = listings.items.map((l, i) => ({ ...l, endsAt: future(60_000 * (i + 2)), status: 'active' }));
    items[0] = { ...items[0], id: LISTING_ID, type: 'auction', minNextBid: 40, buyoutPrice: null, currentBid: 30, isMine: false };
    t = new MockTransport()
      .on('GET /health', { body: fixture('health.json') })
      .on('GET /config', { body: fixture('config.json') })
      .on('GET /auth/providers', { body: fixture('providers.json') })
      .on('GET /characters', { body: fixture('characters.json') })
      .on('GET /packs', { body: fixture('packs.json') })
      .on('GET /rates', { body: fixture('rates.json') })
      .on('GET /feed', { body: fixture('feed.json') })
      .on('GET /me', { body: { ...ME, freePacks: 5, freePacksMax: 15, pity: 12 } })
      .on('GET /me/packs', { body: { limits: {} } })
      .on('GET /me/collection', { body: [{ characterId: 127691, qty: 2, listable: 1, firstAt: new Date().toISOString() }] })
      .on('GET /me/progress', {
        body: { claimable: 0, resets: { nextDaily: future(3600_000), nextWeekly: future(86_400_000) }, daily: { missions: [{ id: 'd1', label: 'Open 5 boosters', progress: 2, target: 5 }] }, weekly: null, achievements: [], series: [] },
      })
      .on('GET /me/market', { body: { listings: [], bids: [], buyOrders: [], holds: [] } })
      .on('GET /me/market/access', { body: { allowed: true, reasons: [] } })
      .on('GET /market/listings', { body: { items, total: items.length } })
      .on(`GET /market/listings/${LISTING_ID}`, { body: items[0] })
      .on('GET /me/trades', {
        body: {
          outgoing: [
            { id: TRADE_ID, from: { id: ME.id, pseudo: 'tester' }, to: OTHER, give: { cards: [{ characterId: 127691, qty: 1 }], chakra: 0 }, want: { cards: [], chakra: 120 }, message: 'Hi Alolo! Saw your Satoru Gojou in the market chat.', status: 'pending', offerId: null, createdAt: new Date().toISOString(), expiresAt: future(48 * 3600_000), messages: 0 },
          ],
          incoming: [
            { id: '55555555-2222-4333-8444-555555555555', from: OTHER, to: { id: ME.id, pseudo: 'tester' }, give: { cards: [{ characterId: 40, qty: 1 }], chakra: 0 }, want: { cards: [{ characterId: 127691, qty: 1 }], chakra: 0 }, message: null, status: 'accepted', offerId: null, createdAt: new Date(Date.now() - 3600_000).toISOString(), expiresAt: future(40 * 3600_000), messages: 0 },
          ],
        },
      })
      .on(`POST /trades/${TRADE_ID}/cancel`, { body: { user: ME } })
      .on('GET /market/chat/rooms', { body: { rooms: [{ room: 1, count: 2 }] } })
      .on('GET /market/chat', { body: { items: [], hasMore: false } })
      .on('GET /me/wishlist', { body: [] })
      .onMatch(/^GET \/characters\/\d+$/, { body: fixture('character-detail.json') })
      .onMatch(/^GET \/market\/prices\/\d+$/, { body: fixture('prices.json') })
      // The opening is slow on purpose: the reveal must wait for it.
      .on('POST /packs/all/open', async () => {
        await new Promise((r) => setTimeout(r, 1200));
        return { body: openResult(1000, [card(127691, 'M', { isNew: true, name: 'Satoru Gojou' }), card(40, 'R')]) };
      });
    const made = makeBot(t, { overrides: { logger: silentLogger }, env: { KYARA_MAX_SPEND_PER_ACTION: '5000' } });
    made.bot.passes.importPass(JSON.stringify({ pass: 'e2e-pass-0123456789', expiresAt: Date.now() + 25 * 60_000 }));
    server = new KyaraServer(made.bot, new EventHub(), { port: 0, webRoot: path.join(ROOT, 'web', 'dist'), version: 'e2e' });
    await server.start();
    base = server.address;
    const { chromium } = await import('playwright');
    browser = await chromium.launch({ headless: true });
    page = await browser.newPage({ viewport: { width: 1360, height: 860 } });
    page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
    page.on('pageerror', (e) => errors.push(e.message));
  }, 180_000);

  afterAll(async () => {
    await browser?.close();
    await server?.stop();
  });

  it.each([
    ['/', 'Dashboard'],
    ['/missions', 'Missions'],
    ['/characters', 'Characters'],
    ['/collection', 'My collection'],
    ['/market', 'Market'],
    ['/packs', 'Packs'],
    ['/automation', 'Monitors'],
    ['/session', 'Session & bridge'],
    ['/activity', 'Activity'],
    ['/trades', 'Trades'],
    ['/settings', 'Settings'],
  ])('renders %s', async (route, heading) => {
    await page.goto(base + route);
    await expect.poll(() => page.getByRole('heading', { level: 1, name: heading }).isVisible(), { timeout: 15_000 }).toBe(true);
    if (SHOTS) await page.waitForTimeout(600).then(() => page.screenshot({ path: path.join(SHOTS, `${route.slice(1) || 'dashboard'}.png`), fullPage: true }));
    expect(errors).toEqual([]);
  }, 30_000);

  it('serves the app with a strict CSP and no CORS', async () => {
    const res = await page.request.get(base + '/');
    expect(res.headers()['content-security-policy']).toContain("default-src 'self'");
    expect(res.headers()['access-control-allow-origin']).toBeUndefined();
  });

  it('shows the pack reveal only after Kyara confirmed the opening', async () => {
    await page.goto(base + '/packs');
    await page.getByRole('button', { name: /Shōnen Mix/ }).click();
    const opens = () => t.calls('POST /packs/all/open').length;
    await page.getByRole('button', { name: 'Open one' }).click();
    // free pack: no dialog; the request is in flight, nothing is revealed yet
    await page.waitForTimeout(500);
    expect(await page.getByRole('dialog', { name: 'Opening results' }).count()).toBe(0);
    await expect.poll(() => page.getByRole('dialog', { name: 'Opening results' }).isVisible(), { timeout: 10_000 }).toBe(true);
    expect(opens()).toBe(1);
    await page.getByRole('button', { name: 'Reveal all' }).click().catch(() => undefined);
    await expect.poll(() => page.getByText('Satoru Gojou').first().isVisible()).toBe(true);
    await page.getByRole('button', { name: 'Done' }).click();
    expect(errors).toEqual([]);
  }, 40_000);

  it('asks before spending chakra, and cancelling sends nothing', async () => {
    await page.goto(base + '/packs');
    await page.getByRole('button', { name: /Hall of Fame/ }).click();
    // the panel swaps with an exit animation: clicking earlier can hit the previous pack's button
    await expect.poll(() => page.getByRole('heading', { level: 2, name: 'Hall of Fame' }).isVisible()).toBe(true);
    const before = t.requests.filter((r) => r.method === 'POST').length;
    await page.getByRole('button', { name: 'Open one' }).click();
    const dialog = page.getByRole('dialog', { name: 'Open this pack?' });
    await expect.poll(() => dialog.isVisible(), { timeout: 10_000 }).toBe(true);
    expect(await dialog.innerText()).toContain('750');
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    expect(t.requests.filter((r) => r.method === 'POST').length).toBe(before);
  }, 30_000);

  it('reviews a bid in a confirmation dialog and sends nothing on cancel', async () => {
    await page.goto(`${base}/market?l=${LISTING_ID}`);
    const field = page.getByLabel('Your maximum bid');
    await expect.poll(() => field.isVisible(), { timeout: 10_000 }).toBe(true);
    expect(await field.inputValue()).toBe('40');
    await page.getByRole('button', { name: 'Review bid' }).click();
    const dialog = page.getByRole('dialog', { name: 'Place this bid?' });
    await expect.poll(() => dialog.isVisible(), { timeout: 10_000 }).toBe(true);
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    expect(t.calls(`POST /market/listings/${LISTING_ID}/bid`)).toHaveLength(0);
  }, 30_000);

  it('cancels a pending trade only after confirmation', async () => {
    await page.goto(base + '/trades');
    await expect.poll(() => page.getByText('To Alolo').isVisible(), { timeout: 10_000 }).toBe(true);
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Cancel this trade?' });
    await expect.poll(() => dialog.isVisible()).toBe(true);
    expect(t.calls(`POST /trades/${TRADE_ID}/cancel`)).toHaveLength(0);
    await dialog.getByRole('button', { name: 'Cancel trade' }).click();
    await expect.poll(() => t.calls(`POST /trades/${TRADE_ID}/cancel`).length).toBe(1);
    await page.getByRole('tab', { name: /Received/ }).click();
    await expect.poll(() => page.getByText('From Alolo').isVisible()).toBe(true);
    expect(errors).toEqual([]);
  }, 30_000);

  it('creates a chat-trade monitor in preview mode', async () => {
    await page.goto(base + '/automation');
    await page.getByRole('button', { name: 'New monitor' }).click();
    await page.getByRole('tab', { name: 'Chat trades' }).click();
    await expect.poll(() => page.getByRole('tab', { name: 'Preview', selected: true }).isVisible()).toBe(true);
    if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'trade-editor.png') });
    await page.getByRole('button', { name: 'Create monitor' }).click();
    await expect.poll(() => page.getByText('Chat trades', { exact: true }).first().isVisible(), { timeout: 10_000 }).toBe(true);
    await expect.poll(() => page.getByText('Preview', { exact: true }).first().isVisible()).toBe(true);
    if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'monitors.png'), fullPage: true });
    expect(t.calls('POST /trades')).toHaveLength(0);
    expect(errors).toEqual([]);
  }, 30_000);

  it('asks before raising a spending limit, then applies it', async () => {
    await page.goto(base + '/settings');
    const box = page.getByRole('checkbox', { name: /Sending trades automatically/ });
    await expect.poll(() => box.isVisible(), { timeout: 10_000 }).toBe(true);
    await box.check();
    await page.getByRole('button', { name: 'Save settings' }).click();
    const dialog = page.getByRole('dialog', { name: 'Let the bot spend more?' });
    await expect.poll(() => dialog.isVisible(), { timeout: 10_000 }).toBe(true);
    if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'settings-confirm.png') });
    await dialog.getByRole('button', { name: 'Raise limits' }).click();
    await expect.poll(() => dialog.isVisible()).toBe(false);
    const res = await page.evaluate(async () => {
      const token = ((await (await fetch('/app-api/token')).json()) as { token: string }).token;
      return (await fetch('/app-api/settings', { headers: { 'x-kyara-app-token': token } })).json();
    });
    expect(res.values.autoTrade.enabled).toBe(true);
    expect(errors).toEqual([]);
  }, 30_000);

  it('keeps explorer filters when navigating away and back', async () => {
    await page.goto(base + '/characters');
    await page.getByLabel('Name or ID').fill('levi');
    await expect.poll(() => page.url()).toContain('q=levi');
    await page.getByRole('link', { name: 'Listings' }).click();
    await page.getByRole('link', { name: 'Characters' }).click();
    expect(await page.getByLabel('Name or ID').inputValue()).toBe('levi');
    expect(page.url()).toContain('q=levi');
  }, 30_000);

  it('opens exactly one detail drawer even with other pages kept alive', async () => {
    await page.goto(base + '/characters');
    await expect.poll(() => page.getByRole('heading', { level: 1, name: 'Characters' }).isVisible()).toBe(true);
    await page.getByRole('link', { name: 'My collection' }).click();
    await expect.poll(() => page.getByRole('heading', { level: 1, name: 'My collection' }).isVisible()).toBe(true);
    await page.getByRole('list', { name: 'Characters' }).getByRole('button').first().click();
    await expect.poll(() => page.getByRole('dialog').count(), { timeout: 10_000 }).toBe(1);
    await page.keyboard.press('Escape');
    await expect.poll(() => page.getByRole('dialog').count()).toBe(0);
  }, 30_000);

  it('has no horizontal overflow on a phone', async () => {
    const phone = await browser.newPage({ viewport: { width: 390, height: 844 } });
    for (const route of ['/', '/characters', '/market', '/packs', '/session', '/trades']) {
      await phone.goto(base + route);
      await phone.waitForTimeout(800);
      const overflow = await phone.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      expect(overflow, route).toBe(0);
    }
    await phone.close();
  }, 60_000);
});
