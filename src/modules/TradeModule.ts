import type { KyaraApi } from '../api/KyaraApi.js';
import type { MyTrades, ProposeBody, ProposeResult } from '../api/schemas/trades.js';
import type { PassManager } from '../auth/PassManager.js';
import { withStoredPass } from '../auth/PassManager.js';
import type { ActionGuard, GuardOptions, GuardOutcome } from '../services/ActionGuard.js';
import { ActionRefusedError } from '../utils/errors.js';
import type { TradeCards } from './tradeFairness.js';
import { fairVerdict } from './tradeFairness.js';
import { spareCopies } from './tradePlanner.js';

export interface ProposeOptions extends GuardOptions {
  /** Copies to keep on top of the one the site always keeps. */
  keep?: number;
  /** Human summary, e.g. "give Douma to @x for 120 chakra". */
  summary?: string;
}

/** Proposing and cancelling trades, always through the ActionGuard. It never accepts or declines trades. */
export class TradeModule {
  constructor(
    private readonly api: KyaraApi,
    private readonly guard: ActionGuard,
    private readonly passes?: Pick<PassManager, 'cachedPass' | 'invalidate'>,
  ) {}

  mine(): Promise<MyTrades> {
    return this.api.trades.mine();
  }

  /**
   * Proposes a trade. Preflight re-reads my collection, balance, the fair-play limits with that
   * player and the reference prices, and refuses unless every card given is a spare copy and the
   * site would call the trade fair. Cards offered stay locked by Kyara while the trade is pending.
   */
  async propose(body: ProposeBody, opts: ProposeOptions = {}): Promise<GuardOutcome<ProposeResult>> {
    const keep = opts.keep ?? 0;
    let summary = opts.summary ?? `Propose a trade to ${body.toUserId.slice(0, 8)}`;
    const sig = (s: TradeCards) => `${s.cards.map((c) => `${c.characterId}x${c.qty}`).sort().join('+')}+${s.chakra}c`;
    return this.guard.run<ProposeResult>(
      {
        kind: 'trade.propose',
        key: `trade.propose:${body.toUserId}:${sig(body.give)}:${sig(body.want)}`,
        get summary() {
          return summary;
        },
        cost: body.give.chakra,
        params: { toUserId: body.toUserId, give: body.give, want: body.want },
        confirm: true,
        repeatCooldownMs: 24 * 3600_000,
        validate: () => {
          const sides = [body.give, body.want];
          if (sides.some((s) => s.chakra < 0 || !Number.isInteger(s.chakra) || s.cards.some((c) => c.qty < 1 || !Number.isInteger(c.qty)))) {
            throw new ActionRefusedError('Invalid trade: quantities and chakra must be positive integers.', 'invalid_input');
          }
          if (sides.some((s) => !s.cards.length && !s.chakra)) throw new ActionRefusedError('Both sides of a trade need something.', 'invalid_input');
        },
        preflight: async () => {
          const ids = [...new Set([...body.give.cards, ...body.want.cards].map((c) => c.characterId))];
          const [collection, me, fp, prices] = await Promise.all([
            this.api.account.collection(),
            this.api.account.me(),
            this.api.trades.fairWith(body.toUserId),
            this.api.trades.fairPrices(ids),
          ]);
          const byId = new Map(collection.map((e) => [e.characterId, e]));
          for (const c of body.give.cards) {
            const e = byId.get(c.characterId);
            if (!e || spareCopies(e, keep) < c.qty) throw new ActionRefusedError(`No spare copy of #${c.characterId} left (kept, listed or locked by another trade).`, 'prerequisite');
          }
          if (body.give.chakra > me.chakra) throw new ActionRefusedError(`Not enough chakra: the trade gives ${body.give.chakra}, you have ${me.chakra}.`, 'insufficient_funds');
          const v = fairVerdict(body.give, body.want, new Map(Object.entries(prices).map(([k, n]) => [Number(k), n])), fp);
          if (v.kind === 'over') throw new ActionRefusedError(`Kyara's fair-play limits refuse this trade: ${v.reason}.`, 'over_budget');
          if (v.kind === 'gift') throw new ActionRefusedError(`Too uneven: the site would count it as a ${v.amount} chakra gift.`, 'over_budget');
          if (v.kind === 'unpriced') throw new ActionRefusedError('A card in this trade has no reference price.', 'prerequisite');
          summary = `${opts.summary ?? 'Trade'} (balance ${me.chakra})`;
        },
        execute: () => withStoredPass(this.passes, (pass) => this.api.trades.propose(body, pass), 'proposed'),
        summarize: (r) => ({ tradeId: r.trade?.id ?? null, chakraAfter: r.user.chakra }),
      },
      opts,
    );
  }

  /** Cancels one of my pending proposals (frees the locked copies). Spends nothing. */
  cancel(tradeId: string, opts: GuardOptions = {}): Promise<GuardOutcome<unknown>> {
    return this.guard.run<unknown>(
      {
        kind: 'trade.cancel',
        key: `trade.cancel:${tradeId}`,
        summary: `Cancel trade ${tradeId.slice(0, 8)}`,
        cost: 0,
        params: { tradeId },
        confirm: false,
        repeatCooldownMs: 10_000,
        execute: () => this.api.trades.cancel(tradeId),
        summarize: () => ({}),
      },
      opts,
    );
  }
}
