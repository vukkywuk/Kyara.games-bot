import type { Command } from 'commander';
import { formatDuration } from '../../utils/time.js';
import { EXIT } from '../../utils/errors.js';
import { getBot, isJson } from '../context.js';
import { parseDuration, print, printJson } from '../output.js';
import { readSecret } from '../prompt.js';

export function registerSession(program: Command): void {
  const session = program.command('session').description('log in, inspect and end your Kyara session');

  session
    .command('login')
    .description('open a visible browser, log in with Discord yourself, and save the session token')
    .option('--allow-guest', 'accept a guest (not Discord-linked) account')
    .option('--timeout <duration>', 'how long to wait for you to log in', '10m')
    .action(async (o: { allowGuest?: boolean; timeout: string }, cmd: Command) => {
      const me = await getBot(cmd).session.loginWithBrowser({ allowGuest: o.allowGuest, timeoutMs: parseDuration(o.timeout) });
      if (isJson(cmd)) printJson({ id: me.id, pseudo: me.pseudo ?? null, discordLinked: !!me.discord });
      else print(`Logged in as ${me.pseudo ?? me.id} (${me.chakra} chakra).`);
    });

  session
    .command('import')
    .description('save a token you copied yourself (DevTools -> Local Storage -> kyara_token), read from stdin')
    .option('--device-id <id>', 'the kyara_device value from the same browser (optional)')
    .action(async (o: { deviceId?: string }, cmd: Command) => {
      const token = await readSecret('Paste the token (input is hidden) and press Enter: ');
      const me = await getBot(cmd).session.importToken(token, o.deviceId);
      print(`Token accepted for ${me.pseudo ?? me.id}${me.discord ? '' : ' (guest account)'}. Saved.`);
    });

  session
    .command('import-pass')
    .description('save the pack pass ("kyara_pass" in localStorage) from your normal browser, read hidden from stdin')
    .option('--device-id <id>', 'the "kyara_device" value from the same browser, so requests carry the same device id')
    .action(async (o: { deviceId?: string }, cmd: Command) => {
      const raw = await readSecret('Paste the kyara_pass value (input is hidden) and press Enter: ');
      const { expiresAt } = getBot(cmd).passes.importPass(raw, o.deviceId);
      print(`Pass saved, valid for ${formatDuration(expiresAt - Date.now())}${o.deviceId ? '; device id updated' : ''}.`);
      print(`You can now open packs until ${new Date(expiresAt).toLocaleTimeString()}.`);
    });

  session
    .command('status')
    .description('show whether a session is stored and still accepted by the server')
    .option('--offline', 'do not contact the server')
    .action(async (o: { offline?: boolean }, cmd: Command) => {
      const s = await getBot(cmd).session.status(!o.offline);
      if (isJson(cmd)) return printJson(s);
      print(`Token:        ${s.hasToken ? `present (source: ${s.source})` : 'none'}`);
      if (s.savedAt) print(`Saved at:     ${s.savedAt}`);
      print(`Server check: ${s.valid === null ? 'not checked' : s.valid ? 'valid' : 'REJECTED'}`);
      if (s.user) {
        print(`Account:      ${s.user.pseudo ?? '(no pseudo)'} [${s.user.id}] ${s.user.discordLinked ? 'Discord-linked' : 'guest'}`);
        if (Number.isFinite(s.user.chakra)) print(`Chakra:       ${s.user.chakra}`);
      }
      print(`Pack pass:    ${s.passValidForMs ? `valid for ${formatDuration(s.passValidForMs)}` : 'none (requested when opening packs)'}`);
      if (s.problem) print(`Problem:      ${s.problem}`);
      if (!s.hasToken || s.valid === false) process.exitCode = EXIT.auth;
    });

  session
    .command('logout')
    .description('revoke the token on the server and delete the local session')
    .option('--wipe-browser', "also delete the bot's browser profile (Discord login included)")
    .action(async (o: { wipeBrowser?: boolean }, cmd: Command) => {
      const r = await getBot(cmd).session.logout({ wipeBrowser: o.wipeBrowser });
      print(`Local session removed${r.revoked ? ' and token revoked on the server' : ''}${o.wipeBrowser ? '; browser profile deleted' : ''}.`);
    });
}
