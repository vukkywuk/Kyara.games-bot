import type { Command } from 'commander';
import type { ListingSort } from '../../api/schemas/market.js';
import { AccountWatcher } from '../../services/AccountWatcher.js';
import { AuctionMonitor } from '../../services/AuctionMonitor.js';
import { diffCollections } from '../../services/CollectionTracker.js';
import { ConsoleNotifier } from '../../services/Notifier.js';
import { poll } from '../../services/Poller.js';
import { UsageError } from '../../utils/errors.js';
import { formatDuration } from '../../utils/time.js';
import { getBot, isJson } from '../context.js';
import { parseDuration, parseIntArg, parseRarities, print } from '../output.js';

/** Floors that cannot be lowered from the command line. */
const MIN_INTERVAL = { auctions: 30_000, account: 120_000, collection: 120_000 };

function abortOnSignals(): AbortController {
  const ac = new AbortController();
  const stop = (): void => {
    if (!ac.signal.aborted) process.stderr.write('\nStopping…\n');
    ac.abort();
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  return ac;
}

export function registerMonitor(program: Command): void {
  const monitor = program.command('monitor').description('long-running watchers (notify by default; never spend unless explicitly enabled)');

  monitor
    .command('auctions')
    .description('watch listings matching filters; alert on matches, auctions ending soon, and being outbid')
    .option('-q, --query <text>', 'character name')
    .option('-r, --rarity <r>', 'one rarity')
    .option('-s, --series <name>', 'series')
    .option('--character <id>', 'character id', parseIntArg('character', 1))
    .option('-t, --type <type>', 'auction or fixed')
    .option('--max-price <n>', 'only listings at or below this price', parseIntArg('max-price', 1))
    .option('--ending-soon <duration>', 'alert window before an auction ends', '5m')
    .option('--interval <duration>', 'poll interval (min 30s)', '60s')
    .option('--duration <duration>', 'stop after this long', '6h')
    .option('--pages <n>', 'pages to scan per tick (1..5)', parseIntArg('pages', 1, 5), 1)
    .option('--auto-bid', 'bid your maximum (--max-price) automatically near the end (also requires KYARA_AUTO_BID_ENABLED=true)')
    .option('--copies <n>', 'with --auto-bid: stop once this many copies are won or led', parseIntArg('copies', 1, 50), 1)
    .option('--within <duration>', 'auto-bid only in the last part of an auction', '2m')
    .action(async (o: Record<string, string | number | boolean | undefined>, cmd: Command) => {
      const bot = getBot(cmd);
      const rar = parseRarities(o.rarity as string | undefined);
      if (rar && rar.length > 1) throw new UsageError('One rarity at a time.');
      const ab = bot.config.autoBid;
      if (o.autoBid) {
        if (!ab.enabled) throw new UsageError('Auto-bidding is disabled. Set KYARA_AUTO_BID_ENABLED=true, KYARA_AUTO_BID_BUDGET and KYARA_AUTO_BID_MAX in .env first.');
        if (ab.budget <= 0 || ab.maxBid <= 0) throw new UsageError('KYARA_AUTO_BID_BUDGET and KYARA_AUTO_BID_MAX must be positive.');
        if (o.maxPrice === undefined) throw new UsageError('--auto-bid requires --max-price.');
        if (!bot.http.hasToken()) throw new UsageError('--auto-bid needs a session (`kyara session login`).');
      }
      const mon = new AuctionMonitor(bot.market, new ConsoleNotifier(isJson(cmd)), bot.log.child('auctions'), {
        query: {
          q: o.query as string | undefined,
          rarity: rar?.[0],
          series: o.series as string | undefined,
          characterId: o.character as number | undefined,
          type: o.type as 'auction' | 'fixed' | undefined,
          sort: 'ending' as ListingSort,
          pageSize: 50,
        },
        filter: { maxPrice: o.maxPrice as number | undefined, excludeMine: true },
        endingSoonMs: parseDuration(o.endingSoon as string),
        maxPages: o.pages as number,
        autoBid: o.autoBid
          ? { enabled: true, budget: ab.budget, maxBid: Math.min(ab.maxBid, o.maxPrice as number), onlyWithinMs: parseDuration(o.within as string), copies: o.copies as number }
          : undefined,
      });
      if (o.autoBid) print(`AUTO-BID ON: up to ${o.copies as number} cop${o.copies === 1 ? 'y' : 'ies'}, maximum ${Math.min(ab.maxBid, o.maxPrice as number)} each, budget ${ab.budget}.`);
      const ac = abortOnSignals();
      const r = await poll(() => mon.tick(), {
        intervalMs: parseDuration(o.interval as string),
        minIntervalMs: MIN_INTERVAL.auctions,
        maxDurationMs: parseDuration(o.duration as string),
        signal: ac.signal,
        log: bot.log.child('poll'),
      });
      print(`Monitor ended (${r.reason}) after ${r.ticks} check(s). Reserved by auto-bids: ${mon.reservedChakra}.`);
    });

  monitor
    .command('account')
    .description('alert on free packs, claimable rewards and newly available packs')
    .option('--interval <duration>', 'poll interval (min 2m)', '5m')
    .option('--duration <duration>', 'stop after this long', '12h')
    .option('--auto-claim', 'claim rewards automatically (spends nothing)')
    .option('--auto-open-free <packId>', 'open this pack automatically, only when it costs 0 chakra (uses Turnstile pass; keep the browser visible)')
    .action(async (o: { interval: string; duration: string; autoClaim?: boolean; autoOpenFree?: string }, cmd: Command) => {
      const bot = getBot(cmd);
      if (!bot.http.hasToken()) throw new UsageError('Needs a session (`kyara session login`).');
      if (o.autoOpenFree) await bot.packs.get(o.autoOpenFree);
      const watcher = new AccountWatcher(bot.account, bot.progress, bot.packs, new ConsoleNotifier(isJson(cmd)), bot.log.child('watch'), {
        autoClaim: !!o.autoClaim,
        autoOpenFreePack: o.autoOpenFree ?? null,
      });
      const ac = abortOnSignals();
      const r = await poll(() => watcher.tick(), {
        intervalMs: parseDuration(o.interval),
        minIntervalMs: MIN_INTERVAL.account,
        maxDurationMs: parseDuration(o.duration),
        signal: ac.signal,
        log: bot.log.child('poll'),
      });
      print(`Watcher ended (${r.reason}) after ${r.ticks} check(s).`);
    });

  monitor
    .command('collection')
    .description('report collection changes (new cards, sold/recycled cards)')
    .option('--interval <duration>', 'poll interval (min 2m)', '10m')
    .option('--duration <duration>', 'stop after this long', '12h')
    .action(async (o: { interval: string; duration: string }, cmd: Command) => {
      const bot = getBot(cmd);
      const notifier = new ConsoleNotifier(isJson(cmd));
      let prev = bot.tracker.snapshotOf(await bot.collection.raw());
      const byId = await bot.characters.byIds();
      const name = (id: number): string => byId.get(id)?.name ?? `#${id}`;
      print(`Watching ${prev.entries.length} owned characters every ${formatDuration(Math.max(parseDuration(o.interval), MIN_INTERVAL.collection))}.`);
      const ac = abortOnSignals();
      await poll(
        async () => {
          const now = bot.tracker.snapshotOf(await bot.collection.raw());
          const d = diffCollections(prev, now);
          for (const a of d.added) notifier.notify({ type: 'collection.new', title: `New: ${name(a.characterId)}`, data: a });
          for (const r of d.removed) notifier.notify({ type: 'collection.gone', title: `Gone: ${name(r.characterId)}`, data: r });
          for (const c of d.changed) notifier.notify({ type: 'collection.qty', title: `${name(c.characterId)}: ${c.before} → ${c.after}`, data: c });
          prev = now;
        },
        { intervalMs: parseDuration(o.interval), minIntervalMs: MIN_INTERVAL.collection, maxDurationMs: parseDuration(o.duration), signal: ac.signal, log: bot.log.child('poll') },
      );
    });
}
