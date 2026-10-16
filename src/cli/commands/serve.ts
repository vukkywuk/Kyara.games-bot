import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Command } from 'commander';
import { BRIDGE_DEFAULT_PORT } from '../../bridge/protocol.js';
import { loadConfig, loadDotEnv } from '../../config/config.js';
import { EventHub } from '../../server/EventHub.js';
import { KyaraServer } from '../../server/KyaraServer.js';
import { readBridgeClients } from '../../server/BridgeService.js';
import { UsageError } from '../../utils/errors.js';
import { createLogger } from '../../utils/logger.js';
import { getBot, isJson } from '../context.js';
import { parseIntArg, print, printJson, table } from '../output.js';

/** web/dist next to the package root, whether running from src (tsx) or dist. */
function defaultWebRoot(): string | null {
  const here = path.dirname(fileURLToPath(import.meta.url));
  for (const up of ['../../..', '../../../..']) {
    const candidate = path.resolve(here, up, 'web', 'dist');
    if (fs.existsSync(path.join(candidate, 'index.html'))) return candidate;
  }
  return null;
}

export function registerServe(program: Command): void {
  program
    .command('serve')
    .description('run the local server: web app, app API and the browser-extension bridge (127.0.0.1 only)')
    .option('-p, --port <port>', 'port on 127.0.0.1', parseIntArg('port', 1024, 65535), BRIDGE_DEFAULT_PORT)
    .option('--web-root <dir>', 'directory of the built web app (default: web/dist)')
    .option('--dev-origin <origin>', 'also allow this origin to call the app API (Vite dev server)')
    .action(async (o: { port: number; webRoot?: string; devOrigin?: string }, cmd: Command) => {
      if (o.devOrigin && !/^http:\/\/(localhost|127\.0\.0\.1):\d+$/.test(o.devOrigin)) throw new UsageError('--dev-origin must be a local http origin');
      loadDotEnv();
      const cfg = loadConfig();
      const hub = new EventHub();
      const logger = createLogger({
        level: cfg.logLevel,
        format: cfg.logFormat,
        sink: (line) => {
          process.stderr.write(line + '\n');
          hub.log(line);
        },
      });
      const bot = getBot(cmd, { logger });
      const server = new KyaraServer(bot, hub, {
        port: o.port,
        webRoot: o.webRoot ? path.resolve(o.webRoot) : defaultWebRoot(),
        devOrigin: o.devOrigin ?? null,
        version: '0.3.0',
      });
      await server.start();
      print(`\nKyara is running at ${server.address}`);
      print('Open it in your browser. Pair the extension from Settings → Session & bridge.');
      print('Press Ctrl+C to stop.\n');
      await new Promise<void>((resolve) => {
        const stop = (): void => {
          process.off('SIGINT', stop);
          process.off('SIGTERM', stop);
          resolve();
        };
        process.on('SIGINT', stop);
        process.on('SIGTERM', stop);
      });
      print('Stopping…');
      await server.stop();
    });

  const bridge = program.command('bridge').description('browser-extension bridge (pairing is done from the web app while `kyara serve` runs)');
  bridge
    .command('status')
    .description('paired extensions')
    .action((_o: unknown, cmd: Command) => {
      const clients = readBridgeClients(path.join(getBot(cmd).config.dataDir, 'bridge.json'));
      if (isJson(cmd)) return printJson(clients);
      if (!clients.length) return print('No extension paired. Run `kyara serve`, open the app, and pair from Settings → Session & bridge.');
      print(table(clients, [
        { header: 'Id', get: (c) => c.id.slice(0, 8) },
        { header: 'Label', get: (c) => c.label },
        { header: 'Paired', get: (c) => c.pairedAt.replace('T', ' ').slice(0, 16) },
        { header: 'Last sync', get: (c) => c.lastSyncAt?.replace('T', ' ').slice(0, 16) ?? '–' },
      ]));
    });
  bridge
    .command('unpair <id>')
    .description('revoke a paired extension (by id prefix, or "all")')
    .action((id: string, _o: unknown, cmd: Command) => {
      const file = path.join(getBot(cmd).config.dataDir, 'bridge.json');
      if (!fs.existsSync(file)) return print('Nothing paired.');
      const state = JSON.parse(fs.readFileSync(file, 'utf8')) as { version: 1; clients: Array<{ id: string }> };
      const before = state.clients.length;
      state.clients = id === 'all' ? [] : state.clients.filter((c) => !c.id.startsWith(id));
      fs.writeFileSync(file, JSON.stringify(state, null, 2), { mode: 0o600 });
      print(`${before - state.clients.length} extension(s) unpaired.`);
    });
}
