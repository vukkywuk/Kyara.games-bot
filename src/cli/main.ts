import { Command, CommanderError } from 'commander';
import { EXIT, KyaraError } from '../utils/errors.js';
import { redactString } from '../utils/redact.js';
import { registerAccount } from './commands/account.js';
import { registerActions } from './commands/actions.js';
import { registerApi } from './commands/api.js';
import { registerCharacters } from './commands/characters.js';
import { registerCollection } from './commands/collection.js';
import { registerInfo } from './commands/info.js';
import { registerMarket } from './commands/market.js';
import { registerMonitor } from './commands/monitor.js';
import { registerPacks } from './commands/packs.js';
import { registerProgress } from './commands/progress.js';
import { registerServe } from './commands/serve.js';
import { registerSession } from './commands/session.js';
import { closeBot } from './context.js';

export function buildProgram(): Command {
  const program = new Command()
    .name('kyara')
    .description('Automation bot and CLI for your own Kyara.games account.')
    .version('0.1.0')
    .option('--json', 'machine-readable output on stdout')
    .option('-v, --verbose', 'debug logs (secrets are redacted)')
    .option('--quiet', 'only warnings and errors in logs')
    .option('--via-browser', 'send API requests from inside the bot browser page instead of directly')
    .showHelpAfterError()
    .exitOverride();

  registerSession(program);
  registerCharacters(program);
  registerAccount(program);
  registerCollection(program);
  registerPacks(program);
  registerMarket(program);
  registerProgress(program);
  registerInfo(program);
  registerMonitor(program);
  registerActions(program);
  registerApi(program);
  registerServe(program);
  return program;
}

export async function main(argv: string[]): Promise<number> {
  const program = buildProgram();
  try {
    await program.parseAsync(argv);
    return typeof process.exitCode === 'number' ? process.exitCode : EXIT.ok;
  } catch (err) {
    if (err instanceof CommanderError) {
      // --help / --version also arrive here with exitCode 0.
      return err.exitCode === 0 ? EXIT.ok : EXIT.usage;
    }
    if (err instanceof KyaraError) {
      process.stderr.write(`Error: ${redactString(err.message)}\n`);
      return err.exitCode;
    }
    process.stderr.write(`Unexpected error: ${redactString((err as Error)?.stack ?? String(err))}\n`);
    return EXIT.failure;
  } finally {
    await closeBot();
  }
}

