import type { KyaraApi } from '../api/KyaraApi.js';
import { PassSchema } from '../api/schemas/account.js';
import type { HumanVerifier } from '../browser/TurnstileVerifier.js';
import { HumanVerificationError, KyaraApiError, UsageError } from '../utils/errors.js';
import type { Logger } from '../utils/logger.js';
import type { SessionStore } from './SessionStore.js';

/** Stop using a pass this close to its expiry (a request in flight must not outlive it). */
export const MIN_REMAINING_MS = 60_000;

/** Shared by manual import and bridge sync: one set of rules for what a usable pass is. */
export function validatePass(value: unknown, now = Date.now()): { pass: string; expiresAt: number } {
  const parsed = PassSchema.safeParse(value);
  if (!parsed.success) throw new UsageError('That is not a kyara_pass value (needs "pass" and "expiresAt").');
  if (parsed.data.expiresAt - now <= MIN_REMAINING_MS) {
    throw new UsageError('This pass is expired or about to expire. Refresh the kyara.games tab and copy it again.');
  }
  return { pass: parsed.data.pass, expiresAt: parsed.data.expiresAt };
}

export const IMPORT_PASS_HELP = [
  'Opening packs needs a pass from your normal browser:',
  '  1. Open https://kyara.games there, logged in, and keep the tab visible (the site renews its pass every minute).',
  '  2. DevTools -> Application -> Local Storage -> https://kyara.games: copy "kyara_pass" (and "kyara_device").',
  '  3. Run:  npm run dev -- session import-pass --device-id <kyara_device>   and paste the pass.',
  'A pass lasts about 30 minutes. (--browser-pass tries Cloudflare in the bot browser instead; Cloudflare usually refuses it.)',
].join('\n');

/**
 * The short-lived pass ("laissez-passer") Kyara requires on pack openings while Turnstile is
 * enabled. It comes from `POST /auth/pass` with a Turnstile token. The usual source is the
 * user's own browser (imported, or synced by the extension or the app's Kyara window); the
 * bot's own browser can render the widget on request, but Cloudflare refuses automated
 * browsers (error 600010) and nothing here works around that.
 */
export class PassManager {
  constructor(
    private readonly api: KyaraApi,
    private readonly store: SessionStore,
    private readonly verifierFactory: () => Promise<{ verifier: HumanVerifier; close: () => Promise<void> }>,
    private readonly log: Logger,
  ) {}

  cachedPass(): string | null {
    const p = this.store.load().pass;
    return p && p.expiresAt - Date.now() > MIN_REMAINING_MS ? p.pass : null;
  }

  private required: { value: boolean; at: number } | null = null;

  /**
   * Whether Kyara currently protects pack openings with its Turnstile pass. The site only
   * requests a pass when `/auth/providers` names a Turnstile key; without one it opens packs
   * with no `x-pass` header, and so does the bot. Cached for a few minutes.
   */
  async passRequired(now = Date.now()): Promise<boolean> {
    if (this.required && now - this.required.at < 5 * 60_000) return this.required.value;
    const value = !!(await this.api.catalog.providers()).turnstile;
    this.required = { value, at: now };
    return value;
  }

  /** Stores a pass copied from the browser's localStorage (`kyara_pass`). */
  importPass(raw: string, deviceId?: string): { expiresAt: number } {
    let value: unknown;
    try {
      value = JSON.parse(raw.trim());
      // DevTools sometimes copies the JSON as a quoted string.
      if (typeof value === 'string') value = JSON.parse(value);
    } catch {
      throw new UsageError('Expected the JSON value of "kyara_pass", like {"pass":"…","expiresAt":1760000000000}.');
    }
    const pass = validatePass(value);
    this.store.update({ pass, ...(deviceId ? { deviceId } : {}) });
    return { expiresAt: pass.expiresAt };
  }

  /**
   * Returns a valid pass, or null when the site does not use Turnstile at all.
   * Without `allowBrowser`, a missing pass is an error with import instructions: the bot's
   * automated browser is refused by Cloudflare (600010), so trying it by default only wastes time.
   */
  async ensurePass(opts: { forceRenew?: boolean; allowBrowser?: boolean } = {}): Promise<string | null> {
    if (!opts.forceRenew) {
      const cached = this.cachedPass();
      if (cached) return cached;
    }
    const providers = await this.api.catalog.providers();
    if (!providers.turnstile) return null;
    if (!opts.allowBrowser) {
      throw new HumanVerificationError(`No valid pack pass. No pack was opened.\n${IMPORT_PASS_HELP}`);
    }

    const { verifier, close } = await this.verifierFactory();
    try {
      const token = await verifier.turnstileToken(providers.turnstile, 'pass to open packs');
      const pass = await this.api.account.createPass(token);
      this.store.update({ pass: { pass: pass.pass, expiresAt: pass.expiresAt } });
      this.log.info(`Pack pass obtained, valid until ${new Date(pass.expiresAt).toLocaleTimeString()}.`);
      return pass.pass;
    } catch (err) {
      if (err instanceof HumanVerificationError) {
        throw new HumanVerificationError(`${err.message}\n\nNo pack was opened.\n${IMPORT_PASS_HELP}`);
      }
      throw err;
    } finally {
      await close();
    }
  }

  invalidate(): void {
    this.store.update({ pass: null });
  }
}

/** The pass header the site adds to protected writes (bids, buys, trade proposals). */
export const passHeader = (pass: string | null): Record<string, string> => (pass ? { 'x-pass': pass } : {});

/**
 * Sends a write the site protects with its pass, as the site does: the stored pass is
 * attached when valid, since Kyara does not always require it. `pass_required` means nothing
 * was applied; it is raised as a HumanVerificationError and never retried here.
 */
export async function withStoredPass<T>(passes: Pick<PassManager, 'cachedPass' | 'invalidate'> | undefined, send: (pass: string | null) => Promise<T>, what: string): Promise<T> {
  try {
    return await send(passes?.cachedPass() ?? null);
  } catch (err) {
    if (err instanceof KyaraApiError && err.code === 'pass_required') {
      passes?.invalidate();
      throw new HumanVerificationError(`Kyara asked for its anti-bot pass, so nothing was ${what}. Open kyara.games in a visible tab (or the app's Kyara window) so a fresh pass is synced, then try again.`);
    }
    throw err;
  }
}
