import type { KyaraApi } from '../api/KyaraApi.js';
import type { ClaimKind, ClaimResult, Progress } from '../api/schemas/account.js';
import { CLAIM_KINDS } from '../api/schemas/account.js';
import { ActionRefusedError } from '../utils/errors.js';
import type { ActionGuard, GuardOptions, GuardOutcome } from '../services/ActionGuard.js';

export class ProgressModule {
  constructor(
    private readonly api: KyaraApi,
    private readonly guard: ActionGuard,
  ) {}

  get(): Promise<Progress> {
    return this.api.account.progress();
  }

  /**
   * Claims rewards. Claiming spends nothing, so no confirmation is required, but it
   * still goes through the guard (journal, duplicate protection, ambiguity handling).
   * `all` is what the site's "Tout réclamer" button sends.
   */
  async claim(kind: ClaimKind = 'all', id?: string, opts: GuardOptions = {}): Promise<GuardOutcome<ClaimResult>> {
    return this.guard.run<ClaimResult>(
      {
        kind: 'progress.claim',
        key: `progress.claim:${kind}:${id ?? ''}`,
        summary: `Claim rewards (${kind}${id ? ` ${id}` : ''})`,
        cost: 0,
        params: { kind, id: id ?? null },
        confirm: false,
        repeatCooldownMs: 5_000,
        validate: () => {
          if (!CLAIM_KINDS.includes(kind)) throw new ActionRefusedError(`Unknown claim kind "${kind}"`, 'invalid_input');
          if ((kind === 'series' || kind === 'achievement') && !id) {
            throw new ActionRefusedError(`Claim kind "${kind}" needs an id`, 'invalid_input');
          }
        },
        preflight: async () => {
          if (kind !== 'all') return;
          const p = await this.get();
          if (p.claimable <= 0) throw new ActionRefusedError('Nothing to claim right now.', 'prerequisite');
        },
        execute: () => this.api.account.claim(kind, id),
        summarize: (r) => ({ gained: r.gained, chakraAfter: r.user.chakra, claimableAfter: r.progress.claimable }),
      },
      opts,
    );
  }
}

export { listClaimables } from './progressView.js';
export type { ClaimableItem } from './progressView.js';
