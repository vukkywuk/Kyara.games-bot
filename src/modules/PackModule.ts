import { randomUUID } from 'node:crypto';
import type { KyaraApi } from '../api/KyaraApi.js';
import type { Me, OpenManyResult, OpenResult, PackState, PulledCard } from '../api/schemas/account.js';
import type { Pack, RarityRate } from '../api/schemas/public.js';
import type { PassManager } from '../auth/PassManager.js';
import { IMPORT_PASS_HELP } from '../auth/PassManager.js';
import { ActionRefusedError, HumanVerificationError, KyaraApiError, UsageError } from '../utils/errors.js';
import type { Logger } from '../utils/logger.js';
import type { ActionJournal } from '../services/ActionJournal.js';
import type { ActionGuard, GuardOptions, GuardOutcome } from '../services/ActionGuard.js';
import type { OpenQuote, PackAccess } from './packPricing.js';
import { packAccess, quoteOpen } from './packPricing.js';

export const MAX_OPEN_COUNT = 10;

export interface PackView {
  pack: Pack;
  access: PackAccess | null;
}

export interface OpenSummary {
  packId: string;
  opened: number;
  cards: PulledCard[];
  newCards: number;
  godPacks: number;
  goldenPacks: number;
  chakraAfter: number;
  stopped: { code: string; message?: string } | null;
}

export class PackModule {
  constructor(
    private readonly api: KyaraApi,
    private readonly guard: ActionGuard,
    private readonly journal: ActionJournal,
    private readonly passes: PassManager,
    private readonly log: Logger,
  ) {}

  list(): Promise<Pack[]> {
    return this.api.catalog.packs();
  }

  async get(packId: string): Promise<Pack> {
    const pack = (await this.list()).find((p) => p.id === packId);
    if (!pack) throw new UsageError(`Unknown pack "${packId}". Run \`kyara packs list\` to see ids.`);
    return pack;
  }

  /** Packs with availability/cost for the current account (if logged in). */
  async withAccess(me: Me | null, state: PackState | null): Promise<PackView[]> {
    const packs = await this.list();
    return packs.map((pack) => ({ pack, access: me ? packAccess(pack, me, state) : null }));
  }

  rates(packId?: string): Promise<RarityRate[]> {
    return this.api.catalog.rates(packId);
  }

  async quote(packId: string, count: number): Promise<{ pack: Pack; me: Me; state: PackState; access: PackAccess; quote: OpenQuote }> {
    const [pack, me, state] = await Promise.all([this.get(packId), this.api.account.me(), this.api.account.packState()]);
    return { pack, me, state, access: packAccess(pack, me, state), quote: quoteOpen(pack, me, count) };
  }

  /**
   * Opens `count` packs. Pre-checks availability, daily limits and balance, shows the
   * chakra cost, asks for confirmation when chakra is spent, and sends the site's
   * idempotency key (`x-request-id`) plus a `maxChakra` ceiling.
   */
  async open(
    packId: string,
    count: number,
    opts: GuardOptions & { resumeId?: string; requireFree?: boolean; browserPass?: boolean } = {},
  ): Promise<GuardOutcome<OpenSummary>> {
    if (!Number.isInteger(count) || count < 1 || count > MAX_OPEN_COUNT) {
      throw new ActionRefusedError(`count must be between 1 and ${MAX_OPEN_COUNT}`, 'invalid_input');
    }
    const resume = opts.resumeId ? this.journal.get(opts.resumeId) : undefined;
    if (opts.resumeId && !resume) throw new UsageError(`No recorded action ${opts.resumeId}`);
    if (resume && resume.status !== 'unknown' && resume.status !== 'pending') {
      throw new UsageError(`Action ${resume.id.slice(0, 8)} is already ${resume.status}; nothing to resume.`);
    }
    const requestId = resume?.requestId ?? randomUUID().replace(/-/g, '');
    let ceiling = typeof resume?.params.maxChakra === 'number' ? resume.params.maxChakra : 0;
    let summary = resume?.summary ?? `Open ${count}× pack "${packId}"`;

    return this.guard.run<OpenSummary>(
      {
        kind: 'pack.open',
        key: `pack.open:${packId}:${count}`,
        get summary() {
          return summary;
        },
        get cost() {
          return ceiling;
        },
        params: { packId, count, get maxChakra() { return ceiling; } },
        requestId,
        confirm: true,
        repeatCooldownMs: 2_000,
        preflight: async () => {
          const { pack, me, access, quote } = await this.quote(packId, count);
          // Refuse before the confirmation prompt when Kyara wants a pass and none is available
          // (Cloudflare refuses the bot browser). With Turnstile off, the site sends no pass either.
          if (!this.passes.cachedPass() && (await this.passes.passRequired())) {
            if (opts.dryRun) this.log.warn(`No valid pack pass stored: a real opening would be refused.
${IMPORT_PASS_HELP}`);
            else if (opts.browserPass) this.log.warn('No pack pass stored; trying Cloudflare in the bot browser (usually refused).');
            else throw new ActionRefusedError(`No valid pack pass, so nothing was sent.
${IMPORT_PASS_HELP}`, 'prerequisite');
          }
          if (resume) return; // resuming re-sends the recorded request as-is
          if (!access.openable) throw new ActionRefusedError(`Pack "${pack.name}" cannot be opened: ${access.reason}.`, 'prerequisite');
          if (access.dailyLeft !== null && access.dailyLeft < count) {
            throw new ActionRefusedError(`Only ${access.dailyLeft} opening(s) left today for "${pack.name}".`, 'prerequisite');
          }
          if (opts.requireFree && quote.chakra > 0) {
            throw new ActionRefusedError(`Opening would cost ${quote.chakra} chakra; only free openings are allowed here.`, 'over_budget');
          }
          if (quote.chakra > me.chakra) {
            throw new ActionRefusedError(`Not enough chakra: need ${quote.chakra}, have ${me.chakra}.`, 'insufficient_funds');
          }
          ceiling = quote.chakra;
          const parts = [
            quote.fromGrants && `${quote.fromGrants} granted`,
            quote.fromFree && `${quote.fromFree} free/bonus`,
            quote.paid && `${quote.paid} paid`,
          ].filter(Boolean);
          summary = `Open ${count}× "${pack.name}" (${parts.join(' + ') || 'free'}) — cost ${quote.chakra} chakra (balance ${me.chakra})`;
        },
        execute: () => this.sendOpen(packId, count, requestId, ceiling, !!opts.browserPass),
        summarize: (r) => ({
          opened: r.opened,
          newCards: r.newCards,
          rarities: r.cards.map((c) => c.rarity).join(''),
          chakraAfter: r.chakraAfter,
          stopped: r.stopped?.code ?? null,
        }),
      },
      { ...opts, resume },
    );
  }

  private async sendOpen(packId: string, count: number, requestId: string, maxChakra: number, allowBrowser: boolean): Promise<OpenSummary> {
    const attempt = async (pass: string | null): Promise<OpenSummary> => {
      if (count === 1) {
        return summariseOpen(packId, [await this.api.account.openPack(packId, { requestId, pass, maxChakra })], null);
      }
      const many: OpenManyResult = await this.api.account.openPacks(packId, { count, requestId, pass, maxChakra });
      return summariseOpen(packId, many.results, many.stopped ?? null);
    };
    const pass = await this.passes.ensurePass({ allowBrowser });
    try {
      return await attempt(pass);
    } catch (err) {
      // `pass_required` is a definite refusal (nothing opened); the site renews and re-sends the same request id.
      if (err instanceof KyaraApiError && err.code === 'pass_required') {
        this.passes.invalidate();
        if (!allowBrowser) {
          throw new HumanVerificationError(`The server rejected the stored pass (pass_required). No pack was opened.
${IMPORT_PASS_HELP}`);
        }
        this.log.info('The server asked for a fresh pass; renewing it and re-sending the same request.');
        return attempt(await this.passes.ensurePass({ forceRenew: true, allowBrowser }));
      }
      throw err;
    }
  }
}

export function summariseOpen(packId: string, results: OpenResult[], stopped: OpenSummary['stopped']): OpenSummary {
  const cards = results.flatMap((r) => r.cards);
  const last = results.at(-1);
  return {
    packId,
    opened: results.length,
    cards,
    newCards: cards.filter((c) => c.isNew).length,
    godPacks: results.filter((r) => r.godPack).length,
    goldenPacks: results.filter((r) => r.golden).length,
    chakraAfter: last ? last.user.chakra : NaN,
    stopped,
  };
}
