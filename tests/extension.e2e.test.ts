/// <reference types="chrome" />
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { BrowserContext } from 'playwright';
import { EventHub } from '../src/server/EventHub.js';
import { KyaraServer } from '../src/server/KyaraServer.js';
import { silentLogger } from '../src/utils/logger.js';
import { ME, MockTransport, makeBot } from './helpers.js';

/**
 * Opt-in (KYARA_BROWSER_TESTS=1): loads the built extension into Chromium, pairs it with
 * a real bridge server and checks the session reaches the bot. kyara.games is NOT
 * contacted: Playwright serves a stub page on that origin that only sets localStorage.
 */
const enabled = process.env.KYARA_BROWSER_TESTS === '1';
const ROOT = path.resolve(import.meta.dirname, '..');
const TOKEN = 'e2e-browser-token-0123456789';
const PASS = { pass: 'e2e-pass-abcdef0123456789', expiresAt: Date.now() + 25 * 60_000 };
const DEVICE = 'e2e-device-0123456789';

describe.skipIf(!enabled)('browser extension end to end (stubbed kyara.games)', () => {
  let ctx: BrowserContext;
  let server: KyaraServer;
  let bot: ReturnType<typeof makeBot>['bot'];
  let extId = '';
  let port = 0;

  beforeAll(async () => {
    execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'build-extension.mjs')], { stdio: 'ignore' });
    const t = new MockTransport().on('GET /me', (req) => (req.headers.authorization === `Bearer ${TOKEN}` ? { body: ME } : { status: 401, body: { error: 'unauthorized' } }));
    ({ bot } = makeBot(t, { token: null, overrides: { logger: silentLogger } }));
    server = new KyaraServer(bot, new EventHub(), { port: 0, webRoot: null, version: 'e2e' });
    await server.start();
    port = Number(new URL(server.address).port);

    const { chromium } = await import('playwright');
    const ext = path.join(ROOT, 'extension', 'dist');
    ctx = await chromium.launchPersistentContext(fs.mkdtempSync(path.join(os.tmpdir(), 'kyara-ext-')), {
      channel: 'chromium',
      headless: true,
      args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`],
    });
    // Stub kyara.games: never reach the real site.
    await ctx.route('https://kyara.games/**', (route) =>
      route.fulfill({
        contentType: 'text/html',
        body: `<!doctype html><title>stub</title><script>
          localStorage.setItem('kyara_token', ${JSON.stringify(TOKEN)});
          localStorage.setItem('kyara_device', ${JSON.stringify(DEVICE)});
          localStorage.setItem('kyara_pass', ${JSON.stringify(JSON.stringify(PASS))});
          localStorage.setItem('unrelated_key', 'must-not-be-read');
        </script>`,
      }),
    );
    let sw = ctx.serviceWorkers()[0];
    sw ??= await ctx.waitForEvent('serviceworker');
    extId = new URL(sw.url()).host;
  }, 120_000);

  afterAll(async () => {
    await ctx?.close();
    await server?.stop();
  });

  it('pairs from the popup with a one-time code', async () => {
    const popup = await ctx.newPage();
    await popup.goto(`chrome-extension://${extId}/popup.html`);
    await expect.poll(() => popup.locator('#rows li').count()).toBeGreaterThan(0);
    const { code } = server.bridge.createPairingCode();
    await popup.locator('summary').click();
    await popup.locator('#port').fill(String(port));
    await popup.locator('#code').fill(code.toLowerCase());
    await popup.getByRole('button', { name: 'Pair with the bot' }).click();
    await expect.poll(() => popup.locator('#paired-actions').isVisible(), { timeout: 15_000 }).toBe(true);
    expect(server.bridge.clients()).toHaveLength(1);
    expect(server.bridge.clients()[0]!.label).toBe('Chrome');
    await popup.close();
  }, 60_000);

  it('synchronises token, device and pass from an open Kyara tab', async () => {
    const tab = await ctx.newPage();
    await tab.goto('https://kyara.games/');
    await expect.poll(() => bot.store.token(), { timeout: 30_000 }).toBe(TOKEN);
    await expect.poll(() => bot.passes.cachedPass(), { timeout: 30_000 }).toBe(PASS.pass);
    expect(bot.store.deviceId()).toBe(DEVICE);
    expect(bot.store.tokenSource()).toBe('bridge');
    await tab.close();
  }, 60_000);

  it('the popup reports the connection without showing any secret', async () => {
    const popup = await ctx.newPage();
    await popup.goto(`chrome-extension://${extId}/popup.html`);
    await expect.poll(() => popup.locator('#rows').innerText(), { timeout: 15_000 }).toContain('Connected on port');
    // the account row can arrive a moment after the connection row
    await expect.poll(() => popup.locator('body').innerText(), { timeout: 15_000 }).toContain('Logged in');
    const text = await popup.locator('body').innerText();
    expect(text).not.toContain(TOKEN);
    expect(text).not.toContain(PASS.pass);
    // the pairing secret lives in storage.local; the session material is not persisted there
    const stored = await popup.evaluate(async () => JSON.stringify(await chrome.storage.local.get(null)));
    expect(stored).not.toContain(TOKEN);
    expect(stored).not.toContain(PASS.pass);
    const session = await popup.evaluate(async () => JSON.stringify(await chrome.storage.session.get(null)));
    expect(session).not.toContain(TOKEN);
    expect(session).not.toContain(PASS.pass);
    await popup.close();
  }, 60_000);

  it('unpairing from the popup revokes the client on the bridge', async () => {
    const popup = await ctx.newPage();
    await popup.goto(`chrome-extension://${extId}/popup.html`);
    await popup.getByRole('button', { name: 'Unpair' }).click();
    await expect.poll(() => server.bridge.clients().length, { timeout: 15_000 }).toBe(0);
    await expect.poll(() => popup.locator('#pair-form').isVisible()).toBe(true);
  }, 60_000);
});
