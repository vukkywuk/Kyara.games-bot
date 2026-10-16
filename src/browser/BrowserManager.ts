import fs from 'node:fs';
import path from 'node:path';
import type { BrowserContext, Page } from 'playwright';
import { HumanVerificationError, KyaraError } from '../utils/errors.js';
import type { Logger } from '../utils/logger.js';
import { redactString } from '../utils/redact.js';
import { sleep } from '../utils/time.js';

export interface BrowserManagerOptions {
  baseUrl: string;
  profileDir: string;
  diagnosticsDir: string;
  headless: boolean;
  logger: Logger;
}

/**
 * Owns one persistent Chromium context (a dedicated profile under the data dir, never
 * your everyday browser profile). Persistence means you log in to Discord once; the
 * profile directory is git-ignored and can be wiped with `kyara session logout --wipe-browser`.
 */
export class BrowserManager {
  private context: BrowserContext | null = null;
  private page: Page | null = null;
  private consoleLines: string[] = [];

  constructor(private readonly opts: BrowserManagerOptions) {}

  get isHeadless(): boolean {
    return this.opts.headless;
  }

  async launch(): Promise<BrowserContext> {
    if (this.context) return this.context;
    const { chromium } = await import('playwright');
    fs.mkdirSync(this.opts.profileDir, { recursive: true, mode: 0o700 });
    try {
      this.context = await chromium.launchPersistentContext(this.opts.profileDir, {
        headless: this.opts.headless,
        viewport: { width: 1200, height: 860 },
        locale: 'fr-FR',
      });
    } catch (err) {
      const msg = (err as Error).message ?? '';
      if (/Executable doesn't exist|browserType\.launch/i.test(msg) && /install/i.test(msg)) {
        throw new KyaraError('Chromium is not installed for Playwright. Run `npm run browser:install` once.');
      }
      if (/ProcessSingleton|profile.*in use|lock/i.test(msg)) {
        throw new KyaraError('The bot browser profile is already in use by another kyara process. Close it first.');
      }
      throw err;
    }
    this.context.on('close', () => {
      this.context = null;
      this.page = null;
    });
    return this.context;
  }

  /** Returns the main page, navigated to `pathname` on the Kyara origin. */
  async open(pathname = '/'): Promise<Page> {
    const ctx = await this.launch();
    if (!this.page || this.page.isClosed()) {
      this.page = ctx.pages()[0] ?? (await ctx.newPage());
      this.page.on('console', (m) => {
        this.consoleLines.push(`[${m.type()}] ${redactString(m.text())}`.slice(0, 500));
        if (this.consoleLines.length > 200) this.consoleLines.shift();
      });
    }
    const target = new URL(pathname, this.opts.baseUrl).toString();
    if (this.page.url() !== target) {
      await this.page.goto(target, { waitUntil: 'domcontentloaded', timeout: 45_000 });
    }
    return this.page;
  }

  /** Reads localStorage keys from the Kyara origin (the site keeps its token there). */
  async readLocalStorage(keys: string[]): Promise<Record<string, string | null>> {
    const page = await this.ensureOnOrigin();
    return page.evaluate((ks) => Object.fromEntries(ks.map((k) => [k, localStorage.getItem(k)])), keys);
  }

  /**
   * Like readLocalStorage, but NEVER navigates: returns null while no tab is on the Kyara
   * origin (e.g. you are on discord.com logging in). Used while a human is acting.
   */
  async peekLocalStorage(keys: string[]): Promise<Record<string, string | null> | null> {
    if (!this.context) return null;
    const origin = new URL(this.opts.baseUrl).origin;
    for (const page of this.context.pages()) {
      let pageOrigin: string;
      try {
        pageOrigin = new URL(page.url()).origin;
      } catch {
        continue;
      }
      if (pageOrigin !== origin) continue;
      try {
        return await page.evaluate((ks) => Object.fromEntries(ks.map((k) => [k, localStorage.getItem(k)])), keys);
      } catch {
        // page is mid-navigation; try again on the next poll
      }
    }
    return null;
  }

  async removeLocalStorage(keys: string[]): Promise<void> {
    const page = await this.ensureOnOrigin();
    await page.evaluate((ks) => ks.forEach((k) => localStorage.removeItem(k)), keys);
  }

  /**
   * Polls `check` until it returns a value, while a human acts in the visible window.
   * Throws HumanVerificationError on timeout. Never tries to automate the human step.
   */
  async waitForHuman<T>(
    description: string,
    check: () => Promise<T | null>,
    opts: { timeoutMs: number; intervalMs?: number },
  ): Promise<T> {
    if (this.opts.headless) {
      this.opts.logger.warn(`${description} may need you, but the browser is headless. Set KYARA_HEADLESS=false if this times out.`);
    } else {
      this.opts.logger.info(`Waiting for you in the browser window: ${description}`);
    }
    const deadline = Date.now() + opts.timeoutMs;
    while (Date.now() < deadline) {
      if (!this.context) {
        throw new HumanVerificationError(
          'The browser window was closed before the step completed. Run the command again and keep the window open until the terminal says you are logged in.',
        );
      }
      const v = await check().catch(() => null);
      if (v !== null) return v;
      await sleep(opts.intervalMs ?? 2000);
    }
    await this.captureDiagnostics('human-timeout');
    throw new HumanVerificationError(`Timed out waiting for: ${description}`);
  }

  /**
   * Saves a screenshot, the URL and the (redacted) console log. Storage, cookies and
   * page HTML are deliberately not captured: they can contain credentials.
   */
  async captureDiagnostics(label: string): Promise<string | null> {
    if (!this.page || this.page.isClosed()) return null;
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const dir = path.join(this.opts.diagnosticsDir, `${stamp}-${label.replace(/[^\w-]/g, '_')}`);
    try {
      fs.mkdirSync(dir, { recursive: true });
      await this.page.screenshot({ path: path.join(dir, 'page.png'), fullPage: false });
      const url = new URL(this.page.url());
      url.hash = '';
      url.search = '';
      fs.writeFileSync(
        path.join(dir, 'info.json'),
        JSON.stringify({ url: url.toString(), title: await this.page.title(), console: this.consoleLines }, null, 2),
      );
      this.opts.logger.info(`Diagnostics saved to ${dir}`);
      return dir;
    } catch (err) {
      this.opts.logger.warn('Could not capture diagnostics', { error: (err as Error).message });
      return null;
    }
  }

  async close(): Promise<void> {
    const ctx = this.context;
    this.context = null;
    this.page = null;
    if (ctx) await ctx.close().catch(() => undefined);
  }

  private async ensureOnOrigin(): Promise<Page> {
    const origin = new URL(this.opts.baseUrl).origin;
    if (this.page && !this.page.isClosed()) {
      try {
        if (new URL(this.page.url()).origin === origin) return this.page;
      } catch {
        /* about:blank */
      }
    }
    return this.open('/');
  }
}
