/**
 * Secret redaction for anything that may be logged or written to diagnostics.
 * Redaction is by key name (deep) and by value pattern (bearer tokens, JWT-like
 * strings, query-string tokens), so a secret slipping into a free-form message
 * is still masked.
 */

const SECRET_KEYS =
  /^(authorization|cookie|set-cookie|token|access_?token|refresh_?token|x-pass|pass|turnstile|password|secret|api_?key|session|kyara_token|kyara_pass)$/i;

const PATTERNS: Array<[RegExp, string]> = [
  [/(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, '$1[REDACTED]'],
  [/([?&#](?:token|pass|turnstile|access_token)=)[^&\s"']+/gi, '$1[REDACTED]'],
  // JWT-shaped values
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, '[REDACTED_JWT]'],
];

const registered = new Set<string>();

/** Register a concrete secret value (e.g. the loaded token) so it is masked anywhere it appears. */
export function registerSecret(value: string | null | undefined): void {
  if (value && value.length >= 8) registered.add(value);
}

export function redactString(input: string): string {
  let out = input;
  for (const secret of registered) out = out.split(secret).join('[REDACTED]');
  for (const [re, rep] of PATTERNS) out = out.replace(re, rep);
  return out;
}

export function redact<T>(value: T, depth = 0): T {
  if (depth > 8) return '[…]' as T;
  if (typeof value === 'string') return redactString(value) as T;
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1)) as T;
  if (value instanceof Error) {
    return { name: value.name, message: redactString(value.message) } as T;
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = SECRET_KEYS.test(k) ? (v == null ? v : '[REDACTED]') : redact(v, depth + 1);
    }
    return out as T;
  }
  return value;
}
