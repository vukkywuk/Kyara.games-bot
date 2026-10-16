/**
 * Client for the local app API. The app token is fetched from the same origin and kept
 * in memory only; it travels in a custom header, never in a URL.
 */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly extra: Record<string, unknown> = {},
  ) {
    super(message);
  }
  /** The bot server is not running or not reachable. */
  get offline(): boolean {
    return this.status === 0;
  }
}

const TOKEN_HEADER = 'x-kyara-app-token';
let tokenPromise: Promise<string> | null = null;

async function fetchToken(): Promise<string> {
  let res: Response;
  try {
    res = await fetch('/app-api/token', { cache: 'no-store', credentials: 'same-origin' });
  } catch {
    throw new ApiError(0, 'offline', 'The Kyara bot is not running. Start it with `npm run serve`.');
  }
  if (!res.ok) throw new ApiError(res.status, 'token', 'Could not open a session with the local bot.');
  return ((await res.json()) as { token: string }).token;
}

export function getToken(): Promise<string> {
  tokenPromise ??= fetchToken().catch((e: unknown) => {
    tokenPromise = null;
    throw e;
  });
  return tokenPromise;
}

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
  body?: unknown;
  signal?: AbortSignal;
}

export async function api<T>(path: string, opts: RequestOptions = {}, retried = false): Promise<T> {
  const token = await getToken();
  let res: Response;
  try {
    res = await fetch(`/app-api${path}`, {
      method: opts.method ?? 'GET',
      headers: { [TOKEN_HEADER]: token, ...(opts.body !== undefined ? { 'content-type': 'application/json' } : {}) },
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      signal: opts.signal,
      credentials: 'same-origin',
    });
  } catch (err) {
    if ((err as Error).name === 'AbortError') throw err;
    throw new ApiError(0, 'offline', 'The Kyara bot is not reachable. Is `npm run serve` still running?');
  }
  if (res.status === 401 && !retried) {
    const body = (await res.clone().json().catch(() => ({}))) as { error?: { code?: string } };
    if (body.error?.code === 'app_unauthorized') {
      // The server restarted with a new token.
      tokenPromise = null;
      return api<T>(path, opts, true);
    }
  }
  const data = (await res.json().catch(() => null)) as ({ error?: { code: string; message: string } & Record<string, unknown> } & T) | null;
  if (!res.ok) {
    const e = data?.error;
    const { code, message, ...extra } = e ?? { code: `http_${res.status}`, message: `Request failed (${res.status})` };
    throw new ApiError(res.status, code, message, extra);
  }
  return data as T;
}

export const get = <T>(path: string, signal?: AbortSignal) => api<T>(path, { signal });
export const post = <T>(path: string, body: unknown = {}) => api<T>(path, { method: 'POST', body });
export const put = <T>(path: string, body: unknown) => api<T>(path, { method: 'PUT', body });
export const del = <T>(path: string) => api<T>(path, { method: 'DELETE' });

/** Human sentence for an error, with what to do next. */
export function explain(err: unknown): string {
  if (!(err instanceof ApiError)) return (err as Error)?.message ?? 'Something went wrong.';
  switch (err.code) {
    case 'auth_required':
      return 'No Kyara session. Pair the browser extension or import a token from the Session page.';
    case 'pass_required':
      return 'Opening packs needs a fresh pass from your Kyara tab. Keep kyara.games open with the extension paired.';
    case 'rate_limited':
      return 'Kyara asked to slow down. Try again in a minute.';
    case 'network':
      return 'Kyara did not answer in time. Check your connection and try again.';
    default:
      return err.message;
  }
}
