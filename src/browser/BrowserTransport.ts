import type { Transport, TransportRequest, TransportResponse } from '../api/transport.js';
import { TransportFailure } from '../api/transport.js';
import type { BrowserManager } from './BrowserManager.js';

/**
 * Sends API requests from inside the Kyara page (same-origin fetch). Use it when direct
 * HTTP is not viable (e.g. if the site starts requiring browser-only signals). It goes
 * through the same KyaraHttpClient, so throttling, validation and guards still apply.
 */
export class BrowserTransport implements Transport {
  readonly name = 'browser';
  constructor(private readonly browser: BrowserManager) {}

  async send(req: TransportRequest): Promise<TransportResponse> {
    const page = await this.browser.open('/');
    let out: { status: number; headers: Record<string, string>; text: string } | { error: string; timeout: boolean };
    try {
      out = await page.evaluate(async (r) => {
        try {
          const res = await fetch(r.url, {
            method: r.method,
            headers: r.headers,
            body: r.body,
            signal: AbortSignal.timeout(r.timeoutMs),
            credentials: 'omit',
          });
          const headers: Record<string, string> = {};
          res.headers.forEach((v, k) => (headers[k] = v));
          return { status: res.status, headers, text: await res.text() };
        } catch (e) {
          const name = (e as Error).name;
          return { error: String((e as Error).message), timeout: name === 'TimeoutError' || name === 'AbortError' };
        }
      }, req);
    } catch (err) {
      throw new TransportFailure('Browser page unavailable', 'network', true, { cause: err });
    }
    if ('error' in out) throw new TransportFailure(out.error, out.timeout ? 'timeout' : 'network', false);
    const headers = new Map(Object.entries(out.headers));
    return { status: out.status, text: out.text, headers: { get: (n) => headers.get(n.toLowerCase()) ?? null } };
  }
}
