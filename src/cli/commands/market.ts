import type { Command } from 'commander';
import type { Listing, ListingSort } from '../../api/schemas/market.js';
import { LISTING_MAX_PAGE_SIZE, LISTING_SORTS } from '../../api/schemas/market.js';
import { applyListingFilter, listingPrice } from '../../modules/MarketModule.js';
import { UsageError } from '../../utils/errors.js';
import { formatDuration } from '../../utils/time.js';
import type { ActionFlags } from '../context.js';
import { getBot, guardOptions, isJson, withActionFlags } from '../context.js';
import type { Column } from '../output.js';
import { fmtNum, parseDuration, parseIntArg, parseRarities, print, printJson, table } from '../output.js';

export const listingColumns: Column<Listing>[] = [
  { header: 'Listing id', get: (l) => l.id, max: 36 },
  { header: 'Character', get: (l) => l.character.name, max: 24 },
  { header: 'R', get: (l) => l.character.rarity },
  { header: 'Type', get: (l) => l.type },
  { header: 'Price', get: (l) => fmtNum(listingPrice(l)), align: 'right' },
  { header: 'Min next', get: (l) => fmtNum(l.minNextBid), align: 'right' },
  { header: 'Buyout', get: (l) => fmtNum(l.type === 'fixed' ? l.price : l.buyoutPrice), align: 'right' },
  { header: 'Bids', get: (l) => l.bidCount, align: 'right' },
  { header: 'Ends in', get: (l) => formatDuration(Date.parse(l.endsAt) - Date.now()), align: 'right' },
  { header: 'Med 7d', get: (l) => fmtNum(l.prices?.median7d), align: 'right' },
  { header: 'Me', get: (l) => (l.isMine ? 'mine' : l.leading ? 'leading' : l.myMaxBid ? `max ${l.myMaxBid}` : '') },
];

interface ListOpts {
  query?: string;
  rarity?: string;
  series?: string;
  type?: 'auction' | 'fixed';
  character?: number;
  sort?: string;
  page: number;
  pageSize: number;
  maxPrice?: number;
  minPrice?: number;
  endingWithin?: string;
}

export function registerMarket(program: Command): void {
  const market = program.command('market').alias('listings').description('marketplace: listings, prices, bids and purchases');

  market
    .command('list')
    .description('browse listings (public; a session adds your bid status)')
    .option('-q, --query <text>', 'character name')
    .option('-r, --rarity <r>', 'one rarity (C,U,R,E,L,M)')
    .option('-s, --series <name>', 'series')
    .option('-t, --type <type>', 'auction or fixed')
    .option('--character <id>', 'character id', parseIntArg('character', 1))
    .option('--sort <sort>', `one of ${LISTING_SORTS.join(', ')}`, 'ending')
    .option('-p, --page <n>', 'page number', parseIntArg('page', 1), 1)
    .option('-n, --page-size <n>', `page size (max ${LISTING_MAX_PAGE_SIZE})`, parseIntArg('page-size', 1, LISTING_MAX_PAGE_SIZE), 20)
    .option('--max-price <n>', 'local filter: current price ≤ n', parseIntArg('max-price'))
    .option('--min-price <n>', 'local filter: current price ≥ n', parseIntArg('min-price'))
    .option('--ending-within <duration>', 'local filter, e.g. 30m')
    .action(async (o: ListOpts, cmd: Command) => {
      if (o.sort && !LISTING_SORTS.includes(o.sort as ListingSort)) throw new UsageError(`--sort must be one of ${LISTING_SORTS.join(', ')}`);
      if (o.type && o.type !== 'auction' && o.type !== 'fixed') throw new UsageError('--type must be auction or fixed');
      const rar = parseRarities(o.rarity);
      if (rar && rar.length > 1) throw new UsageError('The market filters one rarity at a time.');
      const page = await getBot(cmd).market.search({
        q: o.query,
        rarity: rar?.[0],
        series: o.series,
        type: o.type,
        characterId: o.character,
        sort: o.sort as ListingSort,
        page: o.page,
        pageSize: o.pageSize,
      });
      const items = applyListingFilter(page.items, {
        maxPrice: o.maxPrice,
        minPrice: o.minPrice,
        endingWithinMs: o.endingWithin ? parseDuration(o.endingWithin) : undefined,
      });
      if (isJson(cmd)) return printJson({ total: page.total, items });
      print(table(items, listingColumns));
      print(`\nPage ${o.page} · ${items.length} shown · ${fmtNum(page.total)} listings match on the server.`);
    });

  market
    .command('show <listingId>')
    .description('one listing in detail')
    .action(async (id: string, _o: unknown, cmd: Command) => {
      const l = await getBot(cmd).market.listing(id);
      if (isJson(cmd)) return printJson(l);
      print(table([l], listingColumns));
      print(`\nSeller ${l.seller.pseudo} · status ${l.status} · ends ${l.endsAt}`);
    });

  market
    .command('prices <characterId>')
    .description('sale history and medians for a character')
    .action(async (id: string, _o: unknown, cmd: Command) => {
      const p = await getBot(cmd).market.prices(parseIntArg('characterId', 1)(id));
      if (isJson(cmd)) return printJson(p);
      print(`Median 7d ${fmtNum(p.median7d)} (${p.sales7d} sales) · 30d ${fmtNum(p.median30d)} (${p.sales30d} sales) · last ${fmtNum(p.lastPrice)} ${p.lastAt ?? ''}`);
      for (const s of p.lastSales.slice(0, 10)) print(`  ${fmtNum(s.price)}  ${s.at ?? ''}`);
    });

  market
    .command('orders <characterId>')
    .description('buy-order book for a character')
    .action(async (id: string, _o: unknown, cmd: Command) => {
      const book = await getBot(cmd).market.orderBook(parseIntArg('characterId', 1)(id));
      if (isJson(cmd)) return printJson(book);
      if (!book.length) return print('No buy orders.');
      for (const b of book) print(`  ${fmtNum(b.price).padStart(8)} × ${b.qty}`);
    });

  market
    .command('mine')
    .description('your listings and orders (raw server response)')
    .action(async (_o: unknown, cmd: Command) => printJson(await getBot(cmd).api.market.mine()));

  withActionFlags(
    market.command('bid <listingId> <maxAmount>').description('place a proxy bid (your maximum is reserved, not necessarily spent)'),
  ).action(async (id: string, amount: string, o: ActionFlags, cmd: Command) => {
    const out = await getBot(cmd).market.bid(id, parseIntArg('maxAmount', 1)(amount), guardOptions(o));
    if (out.status === 'dry-run') return isJson(cmd) ? printJson(out) : print(`[dry run] ${out.summary}`);
    if (isJson(cmd)) return printJson({ action: out.action.id, leading: out.result.leading, user: { chakra: out.result.user.chakra } });
    print(out.result.leading ? `You lead at ${fmtNum(out.result.listing.currentBid ?? null)}.` : 'Someone already has a higher maximum; nothing was taken.');
    print(`Chakra now ${fmtNum(out.result.user.chakra)}.`);
  });

  withActionFlags(
    market
      .command('buy <listingId>')
      .description('buy a fixed-price listing, or an auction at its buyout price')
      .option('--max-price <n>', 'refuse if the price is above this', parseIntArg('max-price', 1)),
  ).action(async (id: string, o: ActionFlags & { maxPrice?: number }, cmd: Command) => {
    const out = await getBot(cmd).market.buy(id, { ...guardOptions(o), maxPrice: o.maxPrice });
    if (out.status === 'dry-run') return isJson(cmd) ? printJson(out) : print(`[dry run] ${out.summary}`);
    if (isJson(cmd)) return printJson({ action: out.action.id, chakra: out.result.user.chakra });
    print(`Bought. Chakra now ${fmtNum(out.result.user.chakra)}.`);
  });

  market
    .command('offers')
    .description('public trade offers')
    .option('-n, --limit <n>', 'rows', parseIntArg('limit', 1), 20)
    .action(async (o: { limit: number }, cmd: Command) => {
      const bot = getBot(cmd);
      const [offers, byId] = await Promise.all([bot.api.market.tradeOffers(), bot.characters.byIds()]);
      if (isJson(cmd)) return printJson(offers);
      print(table(offers.slice(0, o.limit), [
        { header: 'Offer', get: (x) => x.id.slice(0, 8) },
        { header: 'By', get: (x) => x.user.pseudo, max: 16 },
        { header: 'Gives', get: (x) => byId.get(x.characterId)?.name ?? `#${x.characterId}`, max: 24 },
        { header: 'Wants', get: (x) => `${x.wantIds.length} option(s)` },
        { header: 'Status', get: (x) => x.status },
      ]));
    });
}
