import { HumanVerificationError } from '../utils/errors.js';
import type { Logger } from '../utils/logger.js';
import type { BrowserManager } from './BrowserManager.js';

/** Something that can produce a Turnstile token for a site key. */
export interface HumanVerifier {
  turnstileToken(siteKey: string, purpose: string): Promise<string>;
}

/**
 * Produces a Cloudflare Turnstile token the same way the site does: by rendering the
 * official widget (appearance "interaction-only") on a kyara.games page in a real browser.
 * Usually Cloudflare passes silently; when it wants a click, the checkbox appears in the
 * visible window and the user completes it. Nothing here solves, skips or spoofs the challenge.
 */
export class BrowserTurnstileVerifier implements HumanVerifier {
  constructor(
    private readonly browser: BrowserManager,
    private readonly log: Logger,
    private readonly timeoutMs = 180_000,
  ) {}

  async turnstileToken(siteKey: string, purpose: string): Promise<string> {
    const page = await this.browser.open('/');
    this.log.info(`Cloudflare verification for: ${purpose}. If a checkbox appears in the browser, click it.`);
    try {
      const token = await page.evaluate<string>(turnstileScript(siteKey, this.timeoutMs));
      return token;
    } catch (err) {
      await this.browser.captureDiagnostics('turnstile');
      const msg = (err as Error).message;
      throw new HumanVerificationError(
        msg.includes('timeout')
          ? 'Cloudflare verification was not completed in time. Run with a visible browser (KYARA_HEADLESS=false) and click the checkbox if shown.'
          : `Cloudflare verification failed (${msg}). Try again later; do not retry in a loop.`,
      );
    }
  }
}

/**
 * The in-page code, as plain JavaScript text. It is deliberately not a TypeScript function
 * passed to page.evaluate: dev tooling (tsx/esbuild "keepNames") injects a `__name` helper
 * into function bodies, which does not exist inside the page and crashed the verification.
 */
export function turnstileScript(siteKey: string, timeoutMs: number): string {
  const args = JSON.stringify({ siteKey, timeoutMs });
  return `(async function (a) {
  var w = window;
  if (!w.turnstile) {
    await new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
      s.async = true;
      s.onload = function () { resolve(); };
      s.onerror = function () { reject(new Error('turnstile_unavailable')); };
      document.head.appendChild(s);
    });
  }
  var ts = w.turnstile;
  if (!ts) throw new Error('turnstile_unavailable');
  return await new Promise(function (resolve, reject) {
    var box = document.createElement('div');
    box.style.cssText = 'position:fixed;z-index:2147483647;left:50%;top:40%;transform:translate(-50%,-50%)';
    document.body.appendChild(box);
    var id = '';
    function done() {
      try { if (id) ts.remove(id); } catch (e) {}
      box.remove();
    }
    var timer = setTimeout(function () { done(); reject(new Error('turnstile_timeout')); }, a.timeoutMs);
    id = ts.render(box, {
      sitekey: a.siteKey,
      appearance: 'interaction-only',
      callback: function (t) { clearTimeout(timer); done(); resolve(t); },
      'error-callback': function (code) { clearTimeout(timer); done(); reject(new Error('turnstile_failed:' + code)); },
      'timeout-callback': function () { clearTimeout(timer); done(); reject(new Error('turnstile_timeout')); }
    });
  });
})(${args})`;
}
