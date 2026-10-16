import { redact, redactString } from './redact.js';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface Logger {
  debug(msg: string, data?: Record<string, unknown>): void;
  info(msg: string, data?: Record<string, unknown>): void;
  warn(msg: string, data?: Record<string, unknown>): void;
  error(msg: string, data?: Record<string, unknown>): void;
  child(scope: string): Logger;
}

export interface LoggerOptions {
  level: LogLevel;
  /** `json` writes one object per line (for files / log shippers); `pretty` is for humans. */
  format?: 'pretty' | 'json';
  scope?: string;
  /** Logs go to stderr so stdout stays clean for command output (e.g. --json). */
  sink?: (line: string) => void;
}

export function createLogger(opts: LoggerOptions): Logger {
  const sink = opts.sink ?? ((line: string) => process.stderr.write(line + '\n'));
  const format = opts.format ?? 'pretty';

  const emit = (level: LogLevel, msg: string, data?: Record<string, unknown>): void => {
    if (ORDER[level] < ORDER[opts.level]) return;
    const safeMsg = redactString(msg);
    const safeData = data ? redact(data) : undefined;
    if (format === 'json') {
      sink(JSON.stringify({ t: new Date().toISOString(), level, scope: opts.scope, msg: safeMsg, ...safeData }));
      return;
    }
    const scope = opts.scope ? `[${opts.scope}] ` : '';
    const extra = safeData && Object.keys(safeData).length ? ' ' + JSON.stringify(safeData) : '';
    sink(`${level.toUpperCase().padEnd(5)} ${scope}${safeMsg}${extra}`);
  };

  return {
    debug: (m, d) => emit('debug', m, d),
    info: (m, d) => emit('info', m, d),
    warn: (m, d) => emit('warn', m, d),
    error: (m, d) => emit('error', m, d),
    child: (scope) => createLogger({ ...opts, scope: opts.scope ? `${opts.scope}:${scope}` : scope }),
  };
}

export const silentLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => silentLogger,
};
