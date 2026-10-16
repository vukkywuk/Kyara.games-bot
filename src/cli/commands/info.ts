import type { Command } from 'commander';
import type { LadderKey } from '../../api/schemas/public.js';
import { LADDER_KEYS } from '../../api/schemas/public.js';
import { UsageError } from '../../utils/errors.js';
import { formatDuration } from '../../utils/time.js';
import { getBot, isJson } from '../context.js';
import { fmtNum, parseIntArg, print, printJson, table } from '../output.js';

export function registerInfo(program: Command): void {
  program
    .command('leaderboard')
    .description('rankings (public)')
    .option('--by <key>', `ladder: ${LADDER_KEYS.join(', ')}`, 'collection')
    .option('-q, --query <pseudo>', 'search a player')
    .option('-n, --limit <n>', 'rows', parseIntArg('limit', 1), 20)
    .action(async (o: { by: string; query?: string; limit: number }, cmd: Command) => {
      if (!LADDER_KEYS.includes(o.by as LadderKey)) throw new UsageError(`--by must be one of ${LADDER_KEYS.join(', ')}`);
      const bot = getBot(cmd);
      const me = bot.store.load().user?.id;
      const l = await bot.api.catalog.ladder(o.by as LadderKey, { q: o.query, me });
      if (isJson(cmd)) return printJson(l);
      print(table(l.rows.slice(0, o.limit), [
        { header: '#', get: (r) => r.pos, align: 'right' },
        { header: 'Player', get: (r) => r.pseudo, max: 20 },
        { header: 'Owned', get: (r) => fmtNum(r.owned), align: 'right' },
        { header: 'Mythics', get: (r) => r.mythics, align: 'right' },
        { header: 'Series', get: (r) => r.series, align: 'right' },
        { header: 'Achiev.', get: (r) => r.achievements, align: 'right' },
      ]));
      print(`\n${fmtNum(l.total)} ranked players (by ${l.by}).`);
    });

  program
    .command('feed')
    .description('recent notable pulls across the site (public)')
    .action(async (_o: unknown, cmd: Command) => {
      const f = await getBot(cmd).api.catalog.feed();
      if (isJson(cmd)) return printJson(f);
      for (const e of f) print(`${new Date(e.at).toLocaleTimeString()}  ${e.pseudo.padEnd(16)} [${e.rarity}] ${e.name} — ${e.series}${e.godPack ? '  (divine pack)' : ''}`);
    });

  program
    .command('reviews')
    .description('player reviews (public)')
    .option('-n, --limit <n>', 'rows', parseIntArg('limit', 1), 10)
    .action(async (o: { limit: number }, cmd: Command) => {
      const r = await getBot(cmd).api.catalog.reviews();
      if (isJson(cmd)) return printJson(r);
      print(`Average ${r.average}/5 over ${fmtNum(r.count)} reviews.`);
      for (const i of r.items.slice(0, o.limit)) print(`  ${'★'.repeat(i.rating)}${'☆'.repeat(5 - i.rating)} ${i.text ?? ''}`);
    });

  program
    .command('news')
    .description('latest catalogue update and changelog (public)')
    .action(async (_o: unknown, cmd: Command) => {
      const bot = getBot(cmd);
      const [news, log] = await Promise.all([bot.api.catalog.catalogNews(), bot.api.catalog.changelog()]);
      if (isJson(cmd)) return printJson({ catalog: news, changelog: log });
      print(`Catalogue ${news.id}: ${news.before} -> ${news.after} characters${news.addedCount ? ` (+${news.addedCount})` : ''}.`);
      for (const c of log.slice(0, 3)) {
        print(`\n${c.publishedAt?.slice(0, 10) ?? ''}  ${c.title}`);
        for (const i of c.items.slice(0, 6)) print(`  - ${i.text}`);
      }
    });

  program
    .command('status')
    .description('site health, config, free-pack rules and boosts (public)')
    .action(async (_o: unknown, cmd: Command) => {
      const bot = getBot(cmd);
      const [h, c, n] = await Promise.all([bot.api.catalog.health(), bot.api.catalog.config(), bot.api.catalog.notice()]);
      if (isJson(cmd)) return printJson({ health: h, config: c, notice: n, rateLimit: bot.http.rateLimit });
      print(`Site: ${h.ok ? 'OK' : 'DOWN'} · catalogue ${c.catalogSize} characters${h.catalog?.ready === false ? ' (loading)' : ''}`);
      print(`Free packs: max ${c.freePacks.max}, one every ${Math.round(c.freePacks.regenHours * 60)} min`);
      for (const b of c.freePacks.boosts) {
        const now = Date.now();
        const s = Date.parse(b.start);
        const e = Date.parse(b.end);
        const when = now < s ? `starts in ${formatDuration(s - now)}` : now < e ? `ACTIVE, ends in ${formatDuration(e - now)}` : 'ended';
        print(`  Boost "${b.label}" (max ${b.max}): ${when}`);
      }
      print(`Recycle values: ${Object.entries(c.recycle).map(([r, v]) => `${r}=${v}`).join(' ')}`);
      if (c.pity?.rarity) print(`Pity: guaranteed ${c.pity.rarity} within ${c.pity.threshold} packs`);
      if (n.text) print(`Notice: ${n.text}`);
      print(`Rate limit: ${bot.http.rateLimit.remaining ?? '?'}/${bot.http.rateLimit.limit ?? '?'} requests left in the window`);
    });
}
