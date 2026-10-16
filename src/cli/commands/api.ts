import type { Command } from 'commander';
import { z } from 'zod';
import { AuthRequiredError, SchemaMismatchError, UsageError } from '../../utils/errors.js';
import { getBot, isJson } from '../context.js';
import { print, printJson } from '../output.js';

interface Check {
  name: string;
  run: () => Promise<unknown>;
}

/** Top-level shape without values (safe to paste into an issue). */
function shapeOf(v: unknown, depth = 0): unknown {
  if (Array.isArray(v)) return v.length ? [shapeOf(v[0], depth + 1)] : [];
  if (v && typeof v === 'object') {
    if (depth > 1) return '{…}';
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, shapeOf(x, depth + 1)]));
  }
  return v === null ? 'null' : typeof v;
}

export function registerApi(program: Command): void {
  const api = program.command('api').description('developer tools for the Kyara API');

  api
    .command('verify')
    .description('call every READ endpoint and check responses against the schemas (no state changes)')
    .option('--shapes', 'also print the field layout (no values) of authenticated responses')
    .action(async (o: { shapes?: boolean }, cmd: Command) => {
      const bot = getBot(cmd);
      const a = bot.api;
      const checks: Check[] = [
        { name: 'GET /health', run: () => a.catalog.health() },
        { name: 'GET /config', run: () => a.catalog.config() },
        { name: 'GET /auth/providers', run: () => a.catalog.providers() },
        { name: 'GET /characters', run: () => a.catalog.characters() },
        { name: 'GET /characters/:id', run: () => a.catalog.character(127691) },
        { name: 'GET /characters/heritage', run: () => a.catalog.heritage() },
        { name: 'GET /characters/news', run: () => a.catalog.catalogNews() },
        { name: 'GET /packs', run: () => a.catalog.packs() },
        { name: 'GET /packs/:id/characters', run: () => a.catalog.packCharacterIds('all') },
        { name: 'GET /rates', run: () => a.catalog.rates() },
        { name: 'GET /leaderboard', run: () => a.catalog.leaderboard() },
        { name: 'GET /leaderboard/ladder', run: () => a.catalog.ladder('mythics') },
        { name: 'GET /feed', run: () => a.catalog.feed() },
        { name: 'GET /feedback/reviews', run: () => a.catalog.reviews() },
        { name: 'GET /changelog', run: () => a.catalog.changelog() },
        { name: 'GET /market/listings', run: () => a.market.listings({ sort: 'ending', pageSize: 5 }) },
        { name: 'GET /market/prices/:id', run: () => a.market.prices(127691) },
        { name: 'GET /market/buy-orders', run: () => a.market.orderBook(127691) },
        { name: 'GET /trades/offers', run: () => a.market.tradeOffers() },
        { name: 'GET /market/chat/rooms', run: () => a.trades.chatRooms() },
        { name: 'GET /market/chat', run: () => a.trades.chat(1, 20) },
      ];
      const authed: Check[] = [
        { name: 'GET /me', run: () => a.account.me() },
        { name: 'GET /me/bootstrap', run: () => a.account.bootstrap() },
        { name: 'GET /me/collection?lean=1', run: () => a.account.collection() },
        { name: 'GET /me/packs', run: () => a.account.packState() },
        { name: 'GET /me/progress', run: () => a.account.progress() },
        { name: 'GET /me/wishlist', run: () => a.account.wishlist() },
        { name: 'GET /me/market', run: () => a.market.mine() },
        { name: 'GET /me/market/access', run: () => a.market.access() },
        { name: 'GET /me/trades', run: () => a.trades.mine() },
        { name: 'GET /fair-play/prices', run: () => a.trades.fairPrices([127691]) },
        {
          name: 'GET /trades/available|owned, /fair-play/with',
          run: async () => {
            // another player from the public chat (read only)
            const me = await a.account.me();
            const other = (await a.trades.chat(1, 50)).items.find((m) => m.author.id !== me.id)?.author.id;
            if (!other) return null;
            return Promise.all([a.trades.available(other), a.trades.ownedBy(other), a.trades.fairWith(other)]);
          },
        },
      ];
      const loggedIn = bot.http.hasToken();
      const results: Array<{ endpoint: string; ok: boolean; detail: string; shape?: unknown }> = [];
      for (const c of [...checks, ...(loggedIn ? authed : [])]) {
        try {
          const v = await c.run();
          const isAuthed = authed.includes(c);
          results.push({ endpoint: c.name, ok: true, detail: 'schema OK', ...(o.shapes && isAuthed ? { shape: shapeOf(v) } : {}) });
        } catch (err) {
          const detail = err instanceof SchemaMismatchError ? `SCHEMA MISMATCH: ${err.issues}` : err instanceof AuthRequiredError ? 'auth rejected' : (err as Error).message;
          results.push({ endpoint: c.name, ok: false, detail });
        }
      }
      if (isJson(cmd)) printJson(results);
      else {
        for (const r of results) {
          print(`${r.ok ? 'OK  ' : 'FAIL'}  ${r.endpoint.padEnd(30)} ${r.detail}`);
          if (r.shape) print('      ' + JSON.stringify(r.shape));
        }
        if (!loggedIn) print('\n(Authenticated endpoints skipped: no session. Run `kyara session login` to verify them.)');
      }
      if (results.some((r) => !r.ok)) process.exitCode = 1;
    });

  api
    .command('get <path>')
    .description('raw GET of a read-only endpoint, e.g. `kyara api get /me/notifications`')
    .action(async (path: string, _o: unknown, cmd: Command) => {
      if (!path.startsWith('/')) path = '/' + path;
      if (path.startsWith('/admin')) throw new UsageError('Admin endpoints are not supported.');
      const [p, qs] = path.split('?');
      const query = Object.fromEntries(new URLSearchParams(qs ?? ''));
      printJson(await getBot(cmd).http.get(p!.replace(/^\/api/, ''), z.unknown(), { auth: 'optional', query }));
    });
}
