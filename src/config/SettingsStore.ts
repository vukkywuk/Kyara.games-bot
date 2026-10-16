import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { KyaraConfig } from './config.js';

/**
 * Spending limits editable in the app (settings.json in the data folder), so nobody has to edit
 * `.env`. A variable set in the environment / `.env` still wins and shows as locked.
 * Values are applied to the live config object, which the guard and monitors read on every use.
 */
export const SettingsSchema = z.object({
  maxSpendPerAction: z.number().int().min(0).max(10_000_000),
  autoBid: z.object({ enabled: z.boolean(), budget: z.number().int().min(0).max(10_000_000), maxBid: z.number().int().min(0).max(10_000_000) }),
  autoTrade: z.object({ enabled: z.boolean(), budget: z.number().int().min(0).max(10_000_000) }),
});
export type Settings = z.infer<typeof SettingsSchema>;

/** Which setting each environment variable controls. */
export const ENV_FIELDS = {
  KYARA_MAX_SPEND_PER_ACTION: 'maxSpendPerAction',
  KYARA_AUTO_BID_ENABLED: 'autoBid.enabled',
  KYARA_AUTO_BID_BUDGET: 'autoBid.budget',
  KYARA_AUTO_BID_MAX: 'autoBid.maxBid',
  KYARA_AUTO_TRADE_ENABLED: 'autoTrade.enabled',
  KYARA_AUTO_TRADE_BUDGET: 'autoTrade.budget',
} as const;
export type SettingField = (typeof ENV_FIELDS)[keyof typeof ENV_FIELDS];

export interface SettingsView {
  values: Settings;
  /** Fields fixed by an environment variable (value: the variable's name). */
  locked: Partial<Record<SettingField, string>>;
}

const FileSchema = z.object({ version: z.literal(1), settings: SettingsSchema.partial().extend({ autoBid: SettingsSchema.shape.autoBid.partial().optional(), autoTrade: SettingsSchema.shape.autoTrade.partial().optional() }) });

export class SettingsStore {
  private readonly locked: Partial<Record<SettingField, string>>;
  private readonly defaults: Settings;

  constructor(
    private readonly file: string,
    private readonly config: KyaraConfig,
  ) {
    this.locked = Object.fromEntries(Object.entries(ENV_FIELDS).filter(([k]) => config.envKeys.includes(k)).map(([k, f]) => [f, k]));
    // what the config holds before settings are applied: env values or built-in defaults
    this.defaults = current(config);
    this.apply(this.read());
  }

  view(): SettingsView {
    return { values: current(this.config), locked: { ...this.locked } };
  }

  /** Fields whose new value would let the bot spend more (these need an explicit confirmation). */
  raises(next: Settings): string[] {
    const now = current(this.config);
    const out: string[] = [];
    if (next.maxSpendPerAction > now.maxSpendPerAction) out.push('maxSpendPerAction');
    if (next.autoBid.enabled && !now.autoBid.enabled) out.push('autoBid.enabled');
    if (next.autoBid.budget > now.autoBid.budget) out.push('autoBid.budget');
    if (next.autoBid.maxBid > now.autoBid.maxBid) out.push('autoBid.maxBid');
    if (next.autoTrade.enabled && !now.autoTrade.enabled) out.push('autoTrade.enabled');
    if (next.autoTrade.budget > now.autoTrade.budget) out.push('autoTrade.budget');
    return out.filter((f) => !this.locked[f as SettingField]);
  }

  /** Saves and applies. Locked fields keep their environment value whatever is sent. */
  update(next: Settings): SettingsView {
    const parsed = SettingsSchema.parse(next);
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ version: 1, settings: parsed }, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
    this.apply(parsed);
    return this.view();
  }

  private read(): Partial<Settings> {
    try {
      if (!fs.existsSync(this.file)) return {};
      return FileSchema.parse(JSON.parse(fs.readFileSync(this.file, 'utf8'))).settings as Partial<Settings>;
    } catch {
      return {}; // unreadable settings never unlock spending: the defaults (off) apply
    }
  }

  private apply(s: Partial<Settings>): void {
    const c = this.config;
    const d = this.defaults;
    const pick = <T>(field: SettingField, value: T | undefined, fallback: T): T => (this.locked[field] || value === undefined ? fallback : value);
    c.maxSpendPerAction = pick('maxSpendPerAction', s.maxSpendPerAction, d.maxSpendPerAction);
    // mutate in place: modules hold references to these objects
    c.autoBid.enabled = pick('autoBid.enabled', s.autoBid?.enabled, d.autoBid.enabled);
    c.autoBid.budget = pick('autoBid.budget', s.autoBid?.budget, d.autoBid.budget);
    c.autoBid.maxBid = pick('autoBid.maxBid', s.autoBid?.maxBid, d.autoBid.maxBid);
    c.autoTrade.enabled = pick('autoTrade.enabled', s.autoTrade?.enabled, d.autoTrade.enabled);
    c.autoTrade.budget = pick('autoTrade.budget', s.autoTrade?.budget, d.autoTrade.budget);
  }
}

function current(c: KyaraConfig): Settings {
  return { maxSpendPerAction: c.maxSpendPerAction, autoBid: { ...c.autoBid }, autoTrade: { ...c.autoTrade } };
}
