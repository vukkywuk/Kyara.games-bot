import type { Command } from 'commander';
import type { Character } from '../../api/schemas/common.js';
import { RARITY_LABEL } from '../../api/schemas/common.js';
import type { CharacterQuery, CharacterSort } from '../../modules/CharacterModule.js';
import { CHARACTER_SORTS } from '../../modules/CharacterModule.js';
import { UsageError } from '../../utils/errors.js';
import { getBot, isJson } from '../context.js';
import type { Column } from '../output.js';
import { fmtNum, parseIntArg, parseRarities, print, printJson, table } from '../output.js';

export const characterColumns: Column<Character>[] = [
  { header: 'ID', get: (c) => c.id, align: 'right' },
  { header: 'Name', get: (c) => c.name, max: 28 },
  { header: 'R', get: (c) => c.rarity },
  { header: 'Series', get: (c) => c.series, max: 26 },
  { header: 'Pow', get: (c) => c.pow, align: 'right' },
  { header: 'Aura', get: (c) => c.aura, align: 'right' },
  { header: 'Favs', get: (c) => fmtNum(c.favourites), align: 'right' },
  { header: 'Num', get: (c) => c.num },
];

interface FilterOpts {
  rarity?: string;
  series?: string;
  minPow?: number;
  maxPow?: number;
  minAura?: number;
  minFavs?: number;
  sort?: string;
  order?: 'asc' | 'desc';
  limit: number;
  offset: number;
  refresh?: boolean;
}

function addFilters(cmd: Command): Command {
  return cmd
    .option('-r, --rarity <list>', 'rarities, e.g. M or L,M')
    .option('-s, --series <name>', 'series name (partial, accent-insensitive)')
    .option('--min-pow <n>', 'minimum power', parseIntArg('min-pow'))
    .option('--max-pow <n>', 'maximum power', parseIntArg('max-pow'))
    .option('--min-aura <n>', 'minimum aura', parseIntArg('min-aura'))
    .option('--min-favs <n>', 'minimum AniList favourites', parseIntArg('min-favs'))
    .option('--sort <key>', `sort by: ${CHARACTER_SORTS.join(', ')}`)
    .option('--order <dir>', 'asc or desc')
    .option('-n, --limit <n>', 'rows to show', parseIntArg('limit', 1, 10_000), 25)
    .option('--offset <n>', 'rows to skip', parseIntArg('offset'), 0)
    .option('--refresh', 'ignore the local catalogue cache');
}

function toQuery(text: string | undefined, o: FilterOpts): CharacterQuery {
  if (o.sort && !CHARACTER_SORTS.includes(o.sort as CharacterSort)) throw new UsageError(`--sort must be one of ${CHARACTER_SORTS.join(', ')}`);
  if (o.order && o.order !== 'asc' && o.order !== 'desc') throw new UsageError('--order must be asc or desc');
  return {
    text,
    rarities: parseRarities(o.rarity),
    series: o.series,
    minPow: o.minPow,
    maxPow: o.maxPow,
    minAura: o.minAura,
    minFavourites: o.minFavs,
    sort: o.sort as CharacterSort | undefined,
    order: o.order,
    limit: o.limit,
    offset: o.offset,
  };
}

async function runSearch(text: string | undefined, o: FilterOpts, cmd: Command): Promise<void> {
  const res = await getBot(cmd).characters.search(toQuery(text, o), { refresh: o.refresh });
  if (isJson(cmd)) return printJson(res);
  if (!res.items.length) {
    print('No character matches.');
    process.exitCode = 1;
    return;
  }
  print(table(res.items, characterColumns));
  print(`\n${res.items.length} of ${res.total} match(es).`);
}

export function registerCharacters(program: Command): void {
  const chars = program.command('characters').alias('chars').description('search the character catalogue (public)');

  addFilters(chars.command('search <text...>').description('search by name (any word order) or native name')).action(
    (words: string[], o: FilterOpts, cmd: Command) => runSearch(words.join(' '), o, cmd),
  );

  addFilters(chars.command('list').description('list characters with filters')).action((o: FilterOpts, cmd: Command) =>
    runSearch(undefined, o, cmd),
  );

  chars
    .command('show <id>')
    .description('full detail: drop chance per pack and market prices')
    .action(async (id: string, _o: unknown, cmd: Command) => {
      const d = await getBot(cmd).characters.detail(parseIntArg('id', 1)(id));
      if (isJson(cmd)) return printJson(d);
      print(`${d.name} (${d.native ?? ''}) — ${RARITY_LABEL[d.rarity]} — ${d.series}`);
      print(`#${d.id} ${d.num} · pow ${d.pow} · aura ${d.aura} · ${fmtNum(d.favourites)} favourites`);
      if (d.prices) {
        const p = d.prices;
        print(`Market: median 7d ${fmtNum(p.median7d)}, 30d ${fmtNum(p.median30d)}, last ${fmtNum(p.lastPrice)} · sales 7d ${p.sales7d}, 30d ${p.sales30d}`);
      }
      if (d.dropChance) {
        const rows = Object.entries(d.dropChance)
          .filter(([, v]) => v > 0)
          .sort((a, b) => b[1] - a[1]);
        print('\nDrop chance per pack (per booster, %):');
        print(table(rows, [
          { header: 'Pack', get: (r) => r[0] },
          { header: 'Chance %', get: (r) => r[1].toFixed(4), align: 'right' },
        ]));
      }
    });

  chars
    .command('series')
    .description('series in the catalogue with character counts')
    .option('-n, --limit <n>', 'rows', parseIntArg('limit', 1), 30)
    .option('--filter <text>', 'only series containing this text')
    .action(async (o: { limit: number; filter?: string }, cmd: Command) => {
      let rows = await getBot(cmd).characters.seriesSummary();
      if (o.filter) rows = rows.filter((r) => r.series.toLowerCase().includes(o.filter!.toLowerCase()));
      if (isJson(cmd)) return printJson(rows.slice(0, o.limit));
      print(table(rows.slice(0, o.limit), [
        { header: 'Series', get: (r) => r.series, max: 40 },
        { header: 'Chars', get: (r) => r.count, align: 'right' },
        { header: 'M', get: (r) => r.byRarity.M ?? 0, align: 'right' },
        { header: 'L', get: (r) => r.byRarity.L ?? 0, align: 'right' },
        { header: 'E', get: (r) => r.byRarity.E ?? 0, align: 'right' },
      ]));
    });
}
