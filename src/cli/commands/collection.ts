import type { Command } from 'commander';
import { RARITIES, RARITY_LABEL } from '../../api/schemas/common.js';
import { diffCollections } from '../../services/CollectionTracker.js';
import { getBot, isJson } from '../context.js';
import { characterColumns } from './characters.js';
import { fmtNum, parseIntArg, parseRarities, print, printJson, table } from '../output.js';

export function registerCollection(program: Command): void {
  const col = program.command('collection').description('your collection (needs a session)');

  col
    .command('list')
    .description('owned characters')
    .option('-r, --rarity <list>', 'rarities, e.g. L,M')
    .option('-s, --series <name>', 'series (partial)')
    .option('-q, --query <text>', 'name contains')
    .option('--dupes', 'only characters you own more than once')
    .option('-n, --limit <n>', 'rows', parseIntArg('limit', 1), 50)
    .action(async (o: { rarity?: string; series?: string; query?: string; dupes?: boolean; limit: number }, cmd: Command) => {
      const owned = await getBot(cmd).collection.owned({
        rarities: parseRarities(o.rarity),
        series: o.series,
        text: o.query,
        duplicatesOnly: o.dupes,
      });
      if (isJson(cmd)) return printJson(owned);
      print(table(owned.slice(0, o.limit), [
        { header: 'ID', get: (r) => r.characterId, align: 'right' },
        { header: 'Name', get: (r) => r.character?.name ?? '(not in catalogue)', max: 28 },
        { header: 'R', get: (r) => r.character?.rarity },
        { header: 'Series', get: (r) => r.character?.series, max: 26 },
        { header: 'Qty', get: (r) => r.qty, align: 'right' },
        { header: 'Sellable', get: (r) => r.listable, align: 'right' },
      ]));
      print(`\n${Math.min(o.limit, owned.length)} of ${owned.length} shown.`);
    });

  col
    .command('stats')
    .description('completion by rarity and series, duplicates and their recycle value')
    .action(async (_o: unknown, cmd: Command) => {
      const s = await getBot(cmd).collection.stats();
      if (isJson(cmd)) return printJson(s);
      print(`Unique: ${fmtNum(s.unique)}/${fmtNum(s.catalogSize)} (${s.completionPct}%) · copies ${fmtNum(s.copies)} · duplicates ${fmtNum(s.duplicates)}`);
      if (s.duplicateRecycleValue !== null) print(`Recycling every duplicate would give ~${fmtNum(s.duplicateRecycleValue)} chakra.`);
      print('');
      print(table([...RARITIES].reverse(), [
        { header: 'Rarity', get: (r) => RARITY_LABEL[r] },
        { header: 'Owned', get: (r) => s.byRarity[r].owned, align: 'right' },
        { header: 'Total', get: (r) => s.byRarity[r].total, align: 'right' },
        { header: '%', get: (r) => (s.byRarity[r].total ? ((s.byRarity[r].owned / s.byRarity[r].total) * 100).toFixed(1) : '–'), align: 'right' },
      ]));
      print('\nMost complete series:');
      print(table(s.topSeries, [
        { header: 'Series', get: (r) => r.series, max: 40 },
        { header: 'Owned', get: (r) => `${r.owned}/${r.total}`, align: 'right' },
        { header: '%', get: (r) => r.pct, align: 'right' },
      ]));
    });

  col
    .command('missing')
    .description('characters you do not own yet')
    .option('-r, --rarity <list>', 'rarities')
    .option('-s, --series <name>', 'series (partial)')
    .option('-n, --limit <n>', 'rows', parseIntArg('limit', 1), 50)
    .action(async (o: { rarity?: string; series?: string; limit: number }, cmd: Command) => {
      const miss = await getBot(cmd).collection.missing({ rarities: parseRarities(o.rarity), series: o.series });
      if (isJson(cmd)) return printJson(miss);
      print(table(miss.slice(0, o.limit), characterColumns));
      print(`\n${Math.min(o.limit, miss.length)} of ${miss.length} missing shown.`);
    });

  col
    .command('snapshot')
    .description('save the current collection locally (for `collection diff`)')
    .action(async (_o: unknown, cmd: Command) => {
      const bot = getBot(cmd);
      const snap = bot.tracker.snapshotOf(await bot.collection.raw());
      const file = bot.tracker.save(snap);
      print(`Saved ${snap.entries.length} entries to ${file}`);
    });

  col
    .command('diff')
    .description('compare the current collection with the last snapshot')
    .option('--save', 'save the current state as a new snapshot afterwards')
    .action(async (o: { save?: boolean }, cmd: Command) => {
      const bot = getBot(cmd);
      const prev = bot.tracker.latest();
      const now = bot.tracker.snapshotOf(await bot.collection.raw());
      if (!prev) {
        bot.tracker.save(now);
        return print('No previous snapshot; saved one now. Run this again later to see changes.');
      }
      const d = diffCollections(prev, now);
      if (o.save) bot.tracker.save(now);
      if (isJson(cmd)) return printJson(d);
      const byId = await bot.characters.byIds();
      const name = (id: number): string => {
        const c = byId.get(id);
        return c ? `${c.name} [${c.rarity}]` : `#${id}`;
      };
      print(`Since ${d.from}:`);
      print(`  +${d.added.length} new: ${d.added.map((a) => name(a.characterId)).join(', ') || '–'}`);
      print(`  -${d.removed.length} gone: ${d.removed.map((a) => name(a.characterId)).join(', ') || '–'}`);
      print(`  ${d.changed.length} quantity change(s): ${d.changed.map((c) => `${name(c.characterId)} ${c.before}->${c.after}`).join(', ') || '–'}`);
    });
}
