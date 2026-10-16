import type { Command } from 'commander';
import { formatDuration } from '../../utils/time.js';
import { getBot, isJson } from '../context.js';
import { fmtNum, print, printJson } from '../output.js';

export function registerAccount(program: Command): void {
  const account = program.command('account').description('your account (needs a session)');

  account
    .command('me')
    .description('profile, chakra balance and pack counters')
    .action(async (_o: unknown, cmd: Command) => {
      const bot = getBot(cmd);
      const me = await bot.account.me();
      const w = await bot.account.wallet(me);
      if (isJson(cmd)) return printJson({ me, wallet: w });
      print(`${me.pseudo ?? '(no pseudo)'}  [${me.id}]  ${me.discord ? 'Discord-linked' : 'guest'}`);
      print(`Chakra:        ${fmtNum(w.chakra)}${w.chakraHeld ? ` (+ ${fmtNum(w.chakraHeld)} reserved in bids/orders)` : ''}`);
      const next = w.nextFreeAt ? `, next in ${formatDuration(Date.parse(w.nextFreeAt) - Date.now())}` : w.freePacks >= w.freePacksMax ? ', FULL: open some' : '';
      print(`Free packs:    ${w.freePacks}/${w.freePacksMax}${w.freePackRegenMinutes ? ` (one every ${w.freePackRegenMinutes} min${next})` : next}`);
      if (w.pity) print(`Pity:          ${w.pity.count}/${w.pity.threshold} toward a guaranteed ${w.pity.rarity}`);
      if (w.bonusPacks) print(`Bonus packs:   ${w.bonusPacks}`);
      const grants = Object.entries(w.grants).filter(([, n]) => n > 0);
      if (grants.length) print(`Granted packs: ${grants.map(([k, n]) => `${k}×${n}`).join(', ')}`);
      if (w.goldenIn !== null) print(`Golden pack:   ${w.goldenIn === 1 ? 'next opening!' : `in ${w.goldenIn} openings`}`);
      if (w.boostersOpened !== null) print(`Opened so far: ${fmtNum(w.boostersOpened)}`);
      if (w.activeBoost) print(`Boost active:  ${w.activeBoost.label} (max ${w.activeBoost.max}, ends in ${formatDuration(Date.parse(w.activeBoost.endsAt) - Date.now())})`);
    });

  account
    .command('wishlist')
    .description('character ids on your wishlist')
    .action(async (_o: unknown, cmd: Command) => {
      const bot = getBot(cmd);
      const ids = await bot.api.account.wishlist();
      if (isJson(cmd)) return printJson(ids);
      const byId = await bot.characters.byIds();
      if (!ids.length) return print('Wishlist is empty.');
      for (const id of ids) {
        const c = byId.get(id);
        print(c ? `${id}  ${c.name} [${c.rarity}] — ${c.series}` : String(id));
      }
    });
}
