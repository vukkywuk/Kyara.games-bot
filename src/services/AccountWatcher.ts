import type { Me, PackState, Progress } from '../api/schemas/account.js';
import type { Pack } from '../api/schemas/public.js';
import type { AccountModule } from '../modules/AccountModule.js';
import type { PackModule } from '../modules/PackModule.js';
import { MAX_OPEN_COUNT } from '../modules/PackModule.js';
import { packAccess, packUsesFreePacks } from '../modules/packPricing.js';
import type { ProgressModule } from '../modules/ProgressModule.js';
import { ActionRefusedError, HumanVerificationError } from '../utils/errors.js';
import type { Logger } from '../utils/logger.js';
import type { Notifier } from './Notifier.js';

export interface AccountWatcherOptions {
  /** Claim rewards automatically (spends nothing). Off by default. */
  autoClaim: boolean;
  /** Open this pack automatically, only while it costs 0 chakra (free, bonus or granted packs). */
  autoOpenFreePack: string | null;
  /** Checked right before each automatic action: false once the monitor was stopped. */
  isActive?: () => boolean;
}

interface State {
  freePacks: number;
  claimable: number;
  openablePacks: Set<string>;
}

/**
 * Watches the account for things worth acting on: free packs refilled (or capped and
 * wasting regeneration), rewards to claim, packs becoming available. Notifies by default;
 * the two automatic behaviours are opt-in and never spend chakra.
 */
export class AccountWatcher {
  private prev: State | null = null;
  /** Last reason auto-open was blocked, so the same warning is not repeated every tick. */
  private blocked: string | null = null;

  constructor(
    private readonly account: AccountModule,
    private readonly progress: ProgressModule,
    private readonly packs: PackModule,
    private readonly notifier: Notifier,
    private readonly log: Logger,
    private readonly opts: AccountWatcherOptions,
  ) {}

  /** Returns how long to wait before the next check (when the next free pack arrives), if known. */
  async tick(now = Date.now()): Promise<number | undefined> {
    const [me, state, prog, packs] = await Promise.all([
      this.account.me(),
      this.account.packState(),
      this.progress.get(),
      this.packs.list(),
    ]);
    const wallet = await this.account.wallet(me);
    const current = this.evaluate(me, state, prog, packs, wallet.freePacksMax);

    const active = () => !this.opts.isActive || this.opts.isActive();
    let claimed = false;
    if (this.opts.autoClaim && prog.claimable > 0 && active()) claimed = await this.tryClaim();
    if (this.opts.autoOpenFreePack && active()) {
      // a claim can grant bonus packs: re-read the wallet so they are opened in the same run
      const fresh = claimed ? await this.account.me() : me;
      await this.tryOpenFree(this.opts.autoOpenFreePack, fresh, state, packs);
    }
    this.prev = current;
    if (!this.opts.autoOpenFreePack || !wallet.nextFreeAt) return undefined;
    // wake a few seconds after the next free pack regenerates instead of up to a full interval later
    return Math.max(0, Date.parse(wallet.nextFreeAt) - now) + 5_000;
  }

  /** Pure comparison of the previous and current state; emits events. */
  evaluate(me: Me, state: PackState, prog: Progress, packs: Pack[], freeMax: number): State {
    const openable = new Set(
      packs
        .filter((p) => !p.usesFreePacks)
        .filter((p) => {
          const a = packAccess(p, me, state);
          return a.openable && a.chakra === 0;
        })
        .map((p) => p.id),
    );
    const now: State = { freePacks: me.freePacks ?? 0, claimable: prog.claimable, openablePacks: openable };
    const prev = this.prev;

    if (now.freePacks >= freeMax && (!prev || prev.freePacks < freeMax)) {
      this.notifier.notify({
        type: 'packs.free.full',
        title: `Free packs full (${now.freePacks}/${freeMax})`,
        detail: this.opts.autoOpenFreePack
          ? 'Kyara stops refilling them at the cap. The bot opens them on its next check.'
          : 'Kyara stops refilling them at the cap until some are opened.',
      });
    } else if (prev && prev.freePacks === 0 && now.freePacks > 0) {
      this.notifier.notify({ type: 'packs.free.available', title: `${now.freePacks} free pack(s) available` });
    }
    if (now.claimable > 0 && (!prev || now.claimable > prev.claimable)) {
      this.notifier.notify({ type: 'rewards.claimable', title: `${now.claimable} reward(s) to claim`, detail: 'run `kyara progress claim`' });
    }
    for (const id of openable) {
      if (!prev || !prev.openablePacks.has(id)) {
        const p = packs.find((x) => x.id === id);
        this.notifier.notify({ type: 'packs.available', title: `Pack available at no cost: ${p?.name ?? id}`, data: { packId: id } });
      }
    }
    return now;
  }

  private async tryClaim(): Promise<boolean> {
    try {
      const out = await this.progress.claim('all', undefined, { assumeYes: true });
      if (out.status === 'succeeded') {
        this.notifier.notify({ type: 'rewards.claimed', title: 'Rewards claimed', data: { gained: out.result.gained } });
        return true;
      }
    } catch (err) {
      if (err instanceof ActionRefusedError) this.log.info(`Auto-claim skipped: ${err.message}`);
      else throw err;
    }
    return false;
  }

  private async tryOpenFree(packId: string, me: Me, state: PackState, packs: Pack[]): Promise<void> {
    const pack = packs.find((p) => p.id === packId);
    if (!pack) return this.block(`the pack "${packId}" is not offered any more`);
    const access = packAccess(pack, me, state);
    if (!access.openable || access.chakra !== 0) return; // nothing free right now: normal, wait for regeneration
    // everything that is free right now (grants, then free/bonus packs), in one request
    const free = (me.grants?.[pack.id] ?? 0) + (packUsesFreePacks(pack) ? (me.freePacks ?? 0) + (me.bonusPacks ?? 0) : 0);
    const count = Math.max(1, Math.min(MAX_OPEN_COUNT, free, access.dailyLeft ?? Infinity));
    try {
      // requireFree: the cost is re-quoted in preflight and the opening is refused unless it is 0.
      const out = await this.packs.open(packId, count, { assumeYes: true, requireFree: true });
      if (out.status === 'succeeded') {
        const r = out.result;
        this.blocked = null;
        if (r.chakraAfter < me.chakra) this.log.warn('Unexpected chakra decrease after a free opening; disable auto-open and check.');
        this.notifier.notify({
          type: 'packs.opened',
          title: `Opened ${r.opened > 1 ? `${r.opened}× ` : ''}${pack.name} (free)`,
          detail: r.cards.map((c) => `${c.name} [${c.rarity}]${c.isNew ? ' NEW' : ''}`).join(', '),
        });
      }
    } catch (err) {
      if (err instanceof HumanVerificationError) return this.block('Kyara rejected the pack pass. Keep Kyara open and in view (the app’s Kyara window, or a kyara.games tab with the extension) so a fresh one is synced.');
      if (err instanceof ActionRefusedError) {
        const noPass = err.reason === 'prerequisite' && /pack pass/i.test(err.message);
        return this.block(noPass ? 'No valid pack pass yet. Keep Kyara open and in view (the app’s Kyara window, or a kyara.games tab with the extension) for a few seconds.' : err.message.split('\n')[0]!);
      }
      throw err;
    }
  }

  /** Warns once per distinct reason (until an opening succeeds again). */
  private block(reason: string): void {
    this.log.info(`Auto-open skipped: ${reason}`);
    if (this.blocked === reason) return;
    this.blocked = reason;
    this.notifier.notify({ type: 'packs.autoopen.blocked', title: 'Free packs not opened', detail: reason });
  }
}
