import type { Command } from 'commander';
import { formatDuration } from '../../utils/time.js';
import type { ActionFlags } from '../context.js';
import { getBot, guardOptions, isJson, withActionFlags } from '../context.js';
import { fmtNum, parseIntArg, print, printJson, table } from '../output.js';
import { MAX_OPEN_COUNT } from '../../modules/PackModule.js';
import type { PackAccess } from '../../modules/packPricing.js';

/** Openable now, as the site decides it: allowed by the pack rules and affordable. */
function nowCell(a: PackAccess | null, chakra: number): string {
  if (!a) return '';
  if (!a.openable) return `✗ ${a.reason}`;
  if (a.chakra > chakra) return `✗ ${a.reason} (need ${a.chakra - chakra} more)`;
  return `✓ ${a.reason}`;
}

export function registerPacks(program: Command): void {
  const packs = program.command('packs').description('boosters: list, odds, and opening');

  packs
    .command('list')
    .description('all packs; with a session, also whether each is openable now and its cost')
    .action(async (_o: unknown, cmd: Command) => {
      const bot = getBot(cmd);
      const loggedIn = bot.http.hasToken();
      const [me, state] = loggedIn ? await Promise.all([bot.account.me(), bot.account.packState()]) : [null, null];
      const rows = await bot.packs.withAccess(me, state);
      if (isJson(cmd)) return printJson(rows);
      print(table(rows, [
        { header: 'ID', get: (r) => r.pack.id },
        { header: 'Name', get: (r) => r.pack.name, max: 24 },
        { header: 'Price', get: (r) => r.pack.chakraPrice ?? r.pack.price, align: 'right' },
        { header: 'Free?', get: (r) => (r.pack.usesFreePacks ? 'yes' : '') },
        { header: 'Slots', get: (r) => r.pack.slots?.join('') },
        { header: 'Limit', get: (r) => (r.pack.limit ? `${r.pack.limit.perDay}/day` : r.pack.grantOnly ? 'reward' : '') },
        {
          header: 'Window',
          get: (r) => (r.pack.schedule ? `ends in ${formatDuration(Date.parse(r.pack.schedule.end) - Date.now())}` : ''),
        },
        ...(loggedIn ? [{ header: 'Now', get: (r: (typeof rows)[number]) => nowCell(r.access, me?.chakra ?? 0) }] : []),
      ]));
      if (me) print(`\nBalance: ${fmtNum(me.chakra)} chakra · free packs ${me.freePacks ?? 0}`);
      else print('\n(Log in with `kyara session login` to see availability and cost.)');
    });

  packs
    .command('rates [packId]')
    .description('rarity rates, overall or for one pack')
    .action(async (packId: string | undefined, _o: unknown, cmd: Command) => {
      const rates = await getBot(cmd).packs.rates(packId);
      if (isJson(cmd)) return printJson(rates);
      print(table(rates, [
        { header: 'Rarity', get: (r) => `${r.rarity} ${r.label}` },
        { header: 'Per card %', get: (r) => r.pct.toFixed(3), align: 'right' },
        { header: '≥1 per booster %', get: (r) => r.boosterPct.toFixed(3), align: 'right' },
        { header: 'Expected / booster', get: (r) => r.expectedPerBooster.toFixed(4), align: 'right' },
        { header: 'Specific card %', get: (r) => r.perCardBoosterPct.toFixed(4), align: 'right' },
      ]));
    });

  packs
    .command('pool <packId>')
    .description('characters that can drop from a pack')
    .option('-n, --limit <n>', 'rows', parseIntArg('limit', 1), 30)
    .action(async (packId: string, o: { limit: number }, cmd: Command) => {
      const bot = getBot(cmd);
      const [ids, byId] = await Promise.all([bot.api.catalog.packCharacterIds(packId), bot.characters.byIds()]);
      const chars = ids.map((id) => byId.get(id)).filter((c) => !!c);
      if (isJson(cmd)) return printJson({ packId, size: ids.length, characterIds: ids });
      print(`${ids.length} characters in "${packId}". Top ${Math.min(o.limit, chars.length)} by rank:`);
      for (const c of chars.slice(0, o.limit)) print(`  ${String(c.id).padStart(7)}  [${c.rarity}] ${c.name} — ${c.series}`);
    });

  packs
    .command('quote <packId>')
    .description('what opening would cost right now (no action taken)')
    .option('-c, --count <n>', `packs to open (1..${MAX_OPEN_COUNT})`, parseIntArg('count', 1, MAX_OPEN_COUNT), 1)
    .action(async (packId: string, o: { count: number }, cmd: Command) => {
      const q = await getBot(cmd).packs.quote(packId, o.count);
      if (isJson(cmd)) return printJson({ access: q.access, quote: q.quote, chakra: q.me.chakra });
      print(`${q.pack.name}: ${q.access.openable ? 'openable' : 'NOT openable'} (${q.access.reason})`);
      print(`Opening ${o.count}: ${q.quote.fromGrants} granted + ${q.quote.fromFree} free/bonus + ${q.quote.paid} paid = ${q.quote.chakra} chakra (balance ${q.me.chakra})`);
    });

  withActionFlags(
    packs
      .command('open <packId>')
      .description('open packs (asks for confirmation when chakra is spent)')
      .option('-c, --count <n>', `packs to open (1..${MAX_OPEN_COUNT})`, parseIntArg('count', 1, MAX_OPEN_COUNT), 1)
      .option('--resume <actionId>', 're-send an opening whose outcome was unknown, with the same idempotency key')
      .option('--browser-pass', 'if no pass is stored, try Cloudflare in the bot browser (usually refused; prefer session import-pass)'),
  ).action(async (packId: string, o: ActionFlags & { count: number; resume?: string; browserPass?: boolean }, cmd: Command) => {
    const out = await getBot(cmd).packs.open(packId, o.count, { ...guardOptions(o), resumeId: o.resume, browserPass: o.browserPass });
    if (out.status === 'dry-run') return isJson(cmd) ? printJson(out) : print(`[dry run] ${out.summary}`);
    const r = out.result;
    if (isJson(cmd)) return printJson({ action: out.action.id, ...r });
    print(`Opened ${r.opened} pack(s)${r.godPacks ? ` · ${r.godPacks} DIVINE` : ''}${r.goldenPacks ? ` · ${r.goldenPacks} golden` : ''}:`);
    for (const c of r.cards) print(`  [${c.rarity}] ${c.name} — ${c.series}${c.isNew ? '  NEW' : ''}${c.wished ? '  ♥ wished' : ''}`);
    print(`${r.newCards} new card(s). Chakra now ${fmtNum(r.chakraAfter)}.`);
    if (r.stopped) print(`Stopped early: ${r.stopped.message ?? r.stopped.code}`);
  });
}
