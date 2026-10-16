import type { IncomingMessage, ServerResponse } from 'node:http';
import { gzipSync } from 'node:zlib';
import { redactString } from '../utils/redact.js';

/** An error that maps to an HTTP response. Messages must never contain secrets. */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly extra: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
export const isLoopbackAddress = (addr: string | undefined): boolean => !!addr && LOOPBACK.has(addr);

/**
 * DNS-rebinding guard: a hostile page that resolves its own name to 127.0.0.1 still sends
 * its own Host header. Only our literal loopback names are accepted.
 */
export function isAllowedHost(host: string | undefined, port: number): boolean {
  return host === `127.0.0.1:${port}` || host === `localhost:${port}`;
}

/** Reads a body with a hard size cap (the connection is cut beyond it). */
export function readBody(req: IncomingMessage, limitBytes: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length'] ?? 0);
    if (declared > limitBytes) {
      reject(new HttpError(413, 'payload_too_large', `Body larger than ${limitBytes} bytes`));
      req.resume();
      return;
    }
    let size = 0;
    let tooLarge = false;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (tooLarge) {
        // Discard the rest so a clean 413 can be sent; cut abusive uploads outright.
        if (size > limitBytes * 64) req.destroy();
        return;
      }
      if (size > limitBytes) {
        tooLarge = true;
        chunks.length = 0;
        return;
      }
      chunks.push(c);
    });
    req.on('end', () =>
      tooLarge ? reject(new HttpError(413, 'payload_too_large', `Body larger than ${limitBytes} bytes`)) : resolve(Buffer.concat(chunks).toString('utf8')),
    );
    req.on('error', reject);
  });
}

export function parseJson(text: string): unknown {
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(400, 'bad_json', 'Body is not valid JSON');
  }
}

/** Headers on every response: no framing, no sniffing, no caching of API data, no CORS. */
export function baseHeaders(): Record<string, string> {
  return {
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
    'referrer-policy': 'no-referrer',
    'cross-origin-resource-policy': 'same-origin',
  };
}

export function sendJson(req: IncomingMessage, res: ServerResponse, status: number, body: unknown, cache = 'no-store'): void {
  const json = JSON.stringify(body);
  const headers: Record<string, string> = { ...baseHeaders(), 'content-type': 'application/json; charset=utf-8', 'cache-control': cache };
  let payload: Buffer | string = json;
  if (json.length > 2048 && /\bgzip\b/.test(String(req.headers['accept-encoding'] ?? ''))) {
    payload = gzipSync(json);
    headers['content-encoding'] = 'gzip';
    headers.vary = 'accept-encoding';
  }
  res.writeHead(status, headers);
  res.end(payload);
}

export function sendError(req: IncomingMessage, res: ServerResponse, err: unknown): void {
  if (err instanceof HttpError) {
    sendJson(req, res, err.status, { error: { code: err.code, message: redactString(err.message), ...err.extra } });
    return;
  }
  sendJson(req, res, 500, { error: { code: 'internal', message: 'Internal error' } });
}
