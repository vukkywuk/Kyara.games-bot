/**
 * The transport is the only part of the HTTP stack that differs between running the
 * bot as a plain Node process and running requests inside the authenticated browser
 * page. Business logic only ever sees KyaraHttpClient, so either can be plugged in.
 */

export interface TransportRequest {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  /** Absolute URL. */
  url: string;
  headers: Record<string, string>;
  body?: string;
  timeoutMs: number;
}

export interface TransportResponse {
  status: number;
  headers: { get(name: string): string | null };
  text: string;
}

/** Raised by transports when nothing usable came back. `notSent` means the request provably never left. */
export class TransportFailure extends Error {
  constructor(
    message: string,
    readonly kind: 'timeout' | 'network',
    readonly notSent: boolean,
    options?: { cause?: unknown },
  ) {
    super(message, options);
  }
}

export interface Transport {
  readonly name: string;
  send(req: TransportRequest): Promise<TransportResponse>;
}

const NOT_SENT_CODES = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ERR_INVALID_URL']);

function causeCode(err: unknown): string | undefined {
  let e: unknown = err;
  for (let i = 0; i < 4 && e; i++) {
    const code = (e as { code?: unknown }).code;
    if (typeof code === 'string') return code;
    e = (e as { cause?: unknown }).cause;
  }
  return undefined;
}

/** Node's built-in fetch. Used by default. */
export class FetchTransport implements Transport {
  readonly name = 'fetch';
  constructor(private readonly userAgent = 'kyara-games-bot (+https://github.com/vukkywuk/Kyara.games-bot)') {}

  async send(req: TransportRequest): Promise<TransportResponse> {
    let res: Response;
    try {
      res = await fetch(req.url, {
        method: req.method,
        headers: { 'user-agent': this.userAgent, accept: 'application/json', ...req.headers },
        body: req.body,
        signal: AbortSignal.timeout(req.timeoutMs),
        redirect: 'manual',
      });
    } catch (err) {
      const name = (err as Error)?.name;
      if (name === 'TimeoutError' || name === 'AbortError') {
        throw new TransportFailure(`Request timed out after ${req.timeoutMs} ms`, 'timeout', false, { cause: err });
      }
      const code = causeCode(err);
      throw new TransportFailure(`Network error${code ? ` (${code})` : ''}`, 'network', !!code && NOT_SENT_CODES.has(code), {
        cause: err,
      });
    }
    let text: string;
    try {
      text = await res.text();
    } catch (err) {
      throw new TransportFailure('Connection dropped while reading the response', 'network', false, { cause: err });
    }
    return { status: res.status, headers: res.headers, text };
  }
}
