import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { UsageError } from '../utils/errors.js';

const bool = z
  .enum(['true', 'false', '1', '0', 'yes', 'no'])
  .transform((v) => v === 'true' || v === '1' || v === 'yes');
const int = (min: number, max: number) => z.coerce.number().int().min(min).max(max);

const EnvSchema = z.object({
  KYARA_BASE_URL: z.url().default('https://kyara.games'),
  KYARA_DATA_DIR: z.string().min(1).default('.kyara'),
  KYARA_TOKEN: z.string().min(8).optional(),
  KYARA_TIMEOUT_MS: int(1000, 120_000).default(15_000),
  KYARA_MAX_RETRIES: int(0, 6).default(3),
  KYARA_MIN_INTERVAL_MS: int(50, 60_000).default(250),
  KYARA_HEADLESS: bool.default(false),
  KYARA_LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  KYARA_LOG_FORMAT: z.enum(['pretty', 'json']).default('pretty'),
  KYARA_MAX_SPEND_PER_ACTION: int(0, 10_000_000).default(500),
  KYARA_AUTO_BID_ENABLED: bool.default(false),
  KYARA_AUTO_BID_BUDGET: int(0, 10_000_000).default(0),
  KYARA_AUTO_BID_MAX: int(0, 10_000_000).default(0),
  KYARA_AUTO_TRADE_ENABLED: bool.default(false),
  KYARA_AUTO_TRADE_BUDGET: int(0, 10_000_000).default(0),
});

export interface KyaraConfig {
  baseUrl: string;
  dataDir: string;
  tokenOverride: string | null;
  timeoutMs: number;
  maxRetries: number;
  minIntervalMs: number;
  headless: boolean;
  logLevel: 'debug' | 'info' | 'warn' | 'error';
  logFormat: 'pretty' | 'json';
  maxSpendPerAction: number;
  autoBid: { enabled: boolean; budget: number; maxBid: number };
  /** Sending trades automatically; the budget caps chakra committed in pending proposals (0 = card-for-card only). */
  autoTrade: { enabled: boolean; budget: number };
  /** KYARA_* variables that were explicitly set (they override in-app settings). */
  envKeys: string[];
  paths: {
    session: string;
    browserProfile: string;
    cache: string;
    journal: string;
    diagnostics: string;
    snapshots: string;
  };
}

/** Loads `.env` (if present) into process.env without overriding already-set variables. */
export function loadDotEnv(file = '.env'): void {
  if (!fs.existsSync(file)) return;
  try {
    process.loadEnvFile(file);
  } catch (err) {
    throw new UsageError(`Could not parse ${file}: ${(err as Error).message}`);
  }
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env, cwd = process.cwd()): KyaraConfig {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new UsageError(`Invalid configuration: ${issues}`);
  }
  const e = parsed.data;
  const dataDir = path.resolve(cwd, e.KYARA_DATA_DIR);
  return {
    baseUrl: e.KYARA_BASE_URL.replace(/\/+$/, ''),
    dataDir,
    tokenOverride: e.KYARA_TOKEN ?? null,
    timeoutMs: e.KYARA_TIMEOUT_MS,
    maxRetries: e.KYARA_MAX_RETRIES,
    minIntervalMs: e.KYARA_MIN_INTERVAL_MS,
    headless: e.KYARA_HEADLESS,
    logLevel: e.KYARA_LOG_LEVEL,
    logFormat: e.KYARA_LOG_FORMAT,
    maxSpendPerAction: e.KYARA_MAX_SPEND_PER_ACTION,
    autoBid: { enabled: e.KYARA_AUTO_BID_ENABLED, budget: e.KYARA_AUTO_BID_BUDGET, maxBid: e.KYARA_AUTO_BID_MAX },
    autoTrade: { enabled: e.KYARA_AUTO_TRADE_ENABLED, budget: e.KYARA_AUTO_TRADE_BUDGET },
    envKeys: Object.keys(env).filter((k) => k.startsWith('KYARA_') && env[k] !== undefined && env[k] !== ''),
    paths: {
      session: path.join(dataDir, 'session.json'),
      browserProfile: path.join(dataDir, 'browser-profile'),
      cache: path.join(dataDir, 'cache'),
      journal: path.join(dataDir, 'actions.jsonl'),
      diagnostics: path.join(dataDir, 'diagnostics'),
      snapshots: path.join(dataDir, 'snapshots'),
    },
  };
}
