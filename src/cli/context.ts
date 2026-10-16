import type { Command } from 'commander';
import type { BotOverrides, KyaraBot } from '../bot.js';
import { createKyaraBot } from '../bot.js';
import { loadConfig, loadDotEnv } from '../config/config.js';
import type { GuardOptions } from '../services/ActionGuard.js';
import { confirmPrompt } from './prompt.js';

export interface GlobalOptions {
  json?: boolean;
  verbose?: boolean;
  quiet?: boolean;
  viaBrowser?: boolean;
}

let bot: KyaraBot | null = null;

/** Builds the bot once per process from .env + environment + global flags. */
export function getBot(cmd: Command, overrides: BotOverrides = {}): KyaraBot {
  if (bot) return bot;
  const g = cmd.optsWithGlobals<GlobalOptions>();
  loadDotEnv();
  const env = { ...process.env };
  if (g.verbose) env.KYARA_LOG_LEVEL = 'debug';
  else if (g.quiet) env.KYARA_LOG_LEVEL = 'warn';
  bot = createKyaraBot(loadConfig(env), { ...(g.viaBrowser ? { transport: 'browser' as const } : {}), ...overrides });
  return bot;
}

export function isJson(cmd: Command): boolean {
  return !!cmd.optsWithGlobals<GlobalOptions>().json;
}

export async function closeBot(): Promise<void> {
  const b = bot;
  bot = null;
  if (b) await b.close();
}

export interface ActionFlags {
  yes?: boolean;
  dryRun?: boolean;
  forceBudget?: boolean;
}

export function guardOptions(flags: ActionFlags): GuardOptions {
  return {
    assumeYes: !!flags.yes,
    dryRun: !!flags.dryRun,
    forceBudget: !!flags.forceBudget,
    confirm: confirmPrompt,
  };
}

/** Adds the standard flags of state-changing commands. */
export function withActionFlags(cmd: Command): Command {
  return cmd
    .option('-y, --yes', 'confirm without prompting (you take responsibility for the action)')
    .option('--dry-run', 'run all checks and show what would happen, without sending anything')
    .option('--force-budget', 'allow spending above KYARA_MAX_SPEND_PER_ACTION');
}
