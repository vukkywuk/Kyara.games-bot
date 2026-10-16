import type { KyaraApi } from '../api/KyaraApi.js';
import type { Me, PackState } from '../api/schemas/account.js';
import type { KyaraSiteConfig } from '../api/schemas/public.js';

export interface WalletSummary {
  /** Spendable chakra. */
  chakra: number;
  /** Chakra reserved by bids / buy orders (refunded if outbid), on top of `chakra`. */
  chakraHeld: number;
  /** When the next free pack arrives; null when full or unknown. */
  nextFreeAt: string | null;
  /** Openings since the last Mythic, and the guarantee threshold. */
  pity: { count: number; threshold: number; rarity: string } | null;
  freePacks: number;
  freePacksMax: number;
  bonusPacks: number;
  grants: Record<string, number>;
  goldenIn: number | null;
  boostersOpened: number | null;
  /** Minutes for one free pack to regenerate (from /api/config). */
  freePackRegenMinutes: number | null;
  /** Active boosted free-pack window, if any. */
  activeBoost: { label: string; max: number; endsAt: string } | null;
}

export class AccountModule {
  private siteConfig: KyaraSiteConfig | null = null;

  constructor(private readonly api: KyaraApi) {}

  me(): Promise<Me> {
    return this.api.account.me();
  }

  packState(): Promise<PackState> {
    return this.api.account.packState();
  }

  async config(): Promise<KyaraSiteConfig> {
    this.siteConfig ??= await this.api.catalog.config();
    return this.siteConfig;
  }

  async wallet(me?: Me): Promise<WalletSummary> {
    const [user, cfg] = await Promise.all([me ? Promise.resolve(me) : this.me(), this.config()]);
    return summariseWallet(user, cfg);
  }
}

export function summariseWallet(me: Me, cfg: KyaraSiteConfig, now = Date.now()): WalletSummary {
  const boost = cfg.freePacks.boosts.find((b) => now >= Date.parse(b.start) && now < Date.parse(b.end)) ?? null;
  const pityCfg = cfg.pity;
  const freePacks = me.freePacks ?? 0;
  const freeMax = me.freePacksMax ?? me.freeBoost?.max ?? boost?.max ?? cfg.freePacks.max;
  return {
    chakra: me.chakra,
    chakraHeld: me.chakraHeld ?? 0,
    nextFreeAt: me.nextFreeAt && freePacks < freeMax ? me.nextFreeAt : null,
    pity:
      me.pity !== undefined && pityCfg?.rarity
        ? { count: me.pity, threshold: pityCfg.threshold, rarity: pityCfg.rarity }
        : null,
    freePacks,
    freePacksMax: freeMax,
    bonusPacks: me.bonusPacks ?? 0,
    grants: me.grants ?? {},
    goldenIn: me.goldenIn ?? null,
    boostersOpened: me.boostersOpened ?? null,
    freePackRegenMinutes: regenMinutes(me.freeBoost?.regenHours ?? cfg.freePacks.regenHours),
    activeBoost: boost ? { label: boost.label, max: boost.max, endsAt: boost.end } : null,
  };
}

const regenMinutes = (hours: number): number | null => (hours > 0 ? Math.round(hours * 60) : null);
