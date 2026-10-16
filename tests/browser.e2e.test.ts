import fs from 'node:fs';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { KyaraHttpClient } from '../src/api/KyaraHttpClient.js';
import { BrowserManager } from '../src/browser/BrowserManager.js';
import { BrowserTransport } from '../src/browser/BrowserTransport.js';
import { turnstileScript } from '../src/browser/TurnstileVerifier.js';
import { HealthSchema } from '../src/api/schemas/public.js';
import { silentLogger } from '../src/utils/logger.js';
import { tempDir } from './helpers.js';

/**
 * Opt-in: KYARA_BROWSER_TESTS=1 npm test
 * Hits the real site in headless Chromium. To keep it free of side effects, it blocks
 * guest-account creation, the Turnstile script and every non-GET API call.
 */
const enabled = process.env.KYARA_BROWSER_TESTS === '1';

describe.skipIf(!enabled)('browser integration (live, read-only)', () => {
  const dir = tempDir();
  const browser = new BrowserManager({
    baseUrl: 'https://kyara.games',
    profileDir: path.join(dir, 'profile'),
    diagnosticsDir: path.join(dir, 'diag'),
    headless: true,
    logger: silentLogger,
  });
  const blocked: string[] = [];

  afterAll(() => browser.close());

  it('opens the site with side effects blocked', async () => {
    const ctx = await browser.launch();
    await ctx.route('**/*', (route) => {
      const req = route.request();
      const url = req.url();
      const isApiWrite = url.includes('/api/') && req.method() !== 'GET';
      if (isApiWrite || url.includes('challenges.cloudflare.com')) {
        blocked.push(`${req.method()} ${new URL(url).pathname}`);
        return route.abort();
      }
      return route.continue();
    });
    const page = await browser.open('/');
    await page.waitForLoadState('networkidle', { timeout: 30_000 }).catch(() => undefined);
    expect(await page.title()).toMatch(/Kyara/);
  }, 60_000);

  it('reads localStorage on the Kyara origin (no token without login)', async () => {
    const ls = await browser.readLocalStorage(['kyara_token', 'kyara_device']);
    expect(ls).toHaveProperty('kyara_token');
    expect(ls.kyara_token).toBeNull();
  });

  it('peekLocalStorage never navigates away from another site (e.g. Discord login)', async () => {
    const page = await browser.open('/');
    expect(await browser.peekLocalStorage(['kyara_token'])).toEqual({ kyara_token: null });
    await page.goto('data:text/html,<p>pretend this is discord.com</p>');
    expect(await browser.peekLocalStorage(['kyara_token'])).toBeNull();
    expect(page.url()).toMatch(/^data:/);
    await browser.open('/');
  }, 60_000);

  it('runs the Turnstile page script (against a stub widget, no Cloudflare call)', async () => {
    const page = await browser.open('/');
    await page.goto('data:text/html,<body></body>');
    await page.evaluate('window.turnstile = { render: function (el, o) { setTimeout(function () { o.callback("stub-token"); }, 20); return "w"; }, remove: function () {} }');
    expect(await page.evaluate<string>(turnstileScript('0xKEY', 5000))).toBe('stub-token');
    await page.evaluate('window.turnstile = { render: function (el, o) { setTimeout(function () { o["error-callback"]("600010"); }, 20); return "w"; }, remove: function () {} }');
    await expect(page.evaluate(turnstileScript('0xKEY', 5000))).rejects.toThrow(/turnstile_failed:600010/);
    await browser.open('/');
  }, 60_000);

  it('routes API calls through the page with BrowserTransport', async () => {
    const http = new KyaraHttpClient({
      baseUrl: 'https://kyara.games',
      transport: new BrowserTransport(browser),
      credentials: { getToken: () => null, getDeviceId: () => 'e2e-device' },
      minIntervalMs: 200,
    });
    const health = await http.get('/health', HealthSchema);
    expect(health.ok).toBe(true);
    const listings = await http.get('/market/listings', z.object({ total: z.number() }).loose(), { query: { pageSize: 1 } });
    expect(listings.total).toBeGreaterThan(0);
    expect(http.rateLimit.limit).toBeGreaterThan(0);
  }, 60_000);

  it('captures diagnostics without storage or cookies', async () => {
    const out = await browser.captureDiagnostics('e2e');
    expect(out).not.toBeNull();
    const info = JSON.parse(fs.readFileSync(path.join(out!, 'info.json'), 'utf8')) as Record<string, unknown>;
    expect(Object.keys(info).sort()).toEqual(['console', 'title', 'url']);
    expect(fs.existsSync(path.join(out!, 'page.png'))).toBe(true);
  });

  it('prevented the site’s automatic guest creation', () => {
    // Anonymous visitors may get a guest account after a Turnstile check. The Turnstile script
    // (when the site loads it on landing; since update 1.5 it may not) and every API write are
    // aborted, so no guest is created: the next test checks no token appeared.
    expect(blocked.every((b) => b.includes('/turnstile/') || !b.startsWith('GET'))).toBe(true);
  });
});
