/*
 * Response types of the local app API (src/server/AppApi.ts). Domain types are imported
 * from the backend's schemas (type-only, erased at build), so there is one source of truth.
 */
import type { Character, Rarity } from '../../../src/api/schemas/common';
import type { CharacterDetail, Pack, RarityRate, KyaraSiteConfig, Ladder, PriceStats } from '../../../src/api/schemas/public';
import type { CollectionEntry, Progress, PulledCard, ClaimKind } from '../../../src/api/schemas/account';
import type { Listing, ListingPage } from '../../../src/api/schemas/market';
import type { WalletSummary } from '../../../src/modules/AccountModule';
import type { PackAccess } from '../../../src/modules/packPricing';
import type { CollectionStats } from '../../../src/modules/CollectionModule';
import type { BotSessionView } from '../../../src/bridge/protocol';
import type { Trade, TradeSide } from '../../../src/api/schemas/trades';
import type { SettingField, Settings, SettingsView } from '../../../src/config/SettingsStore';

export type { Character, Rarity, CharacterDetail, Pack, RarityRate, KyaraSiteConfig, Ladder, CollectionEntry, Progress, PulledCard, ClaimKind };
export type { Listing, ListingPage, PriceStats, WalletSummary, PackAccess, CollectionStats, BotSessionView, Trade, TradeSide };

export type { SettingField, Settings, SettingsView };

export interface TradesResponse {
  incoming: Trade[];
  outgoing: Trade[];
  /** Trades proposed by a trade monitor. */
  botTradeIds: string[];
}

export interface BridgeClient {
  id: string;
  label: string;
  pairedAt: string;
  lastSeenAt: string | null;
  lastSyncAt: string | null;
}

export interface AppStatus {
  server: { version: string; startedAt: string; transport: string };
  session: {
    hasToken: boolean;
    source: string;
    savedAt: string | null;
    user: { id: string; pseudo: string | null; discordLinked: boolean } | null;
    problem: string | null;
    passValidForMs: number | null;
  };
  bridge: { clients: BridgeClient[]; pairing: { expiresAt: number } | null };
  site: { ok: boolean; catalogSize: number | null; error: string | null };
  rateLimit: { limit: number | null; remaining: number | null; resetAt: number | null };
  automation: { pausedAll: boolean; autoBidAllowedByConfig: boolean; autoTradeAllowedByConfig: boolean; autoTradeBudget: number; maxSpendPerAction: number };
}

export interface MeResponse {
  profile: { id: string; pseudo: string | null; discordLinked: boolean; createdAt: string | null; boostersOpened: number | null };
  wallet: WalletSummary;
}

export interface PackView {
  pack: Pack;
  access: PackAccess | null;
  affordable: boolean | null;
}

export interface PacksResponse {
  loggedIn: boolean;
  chakra: number | null;
  passValidForMs: number | null;
  /** false while Kyara has its Turnstile check off: packs open without a pass, as on the site. */
  passRequired: boolean;
  packs: PackView[];
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

export type ActionResponse<T> =
  | { status: 'dry-run'; summary: string; cost: number }
  | { status: 'succeeded'; actionId: string; result: T };

export type ActionStatus = 'pending' | 'succeeded' | 'failed' | 'unknown';

export interface ActionRecord {
  id: string;
  kind: string;
  key: string;
  summary: string;
  cost: number;
  params: Record<string, unknown>;
  status: ActionStatus;
  startedAt: string;
  finishedAt: string | null;
  requestId: string | null;
  result: Record<string, unknown> | null;
  error: string | null;
  resolvedBy?: 'user' | null;
}

export type EventLevel = 'info' | 'success' | 'warn' | 'error';
export interface HubEvent {
  id: number;
  at: string;
  type: string;
  level: EventLevel;
  title: string;
  detail?: string;
  data?: Record<string, unknown>;
}
export interface LogLine {
  id: number;
  at: string;
  line: string;
}

export type MonitorKind = 'auctions' | 'account' | 'trades';
export interface AuctionParams {
  q?: string;
  rarity?: Rarity;
  series?: string;
  characterId?: number;
  type?: 'auction' | 'fixed';
  maxPrice?: number;
  endingSoonSec: number;
  pages: number;
  /** budget 0 = copies x maximum price; maxBid 0 = the maximum price. */
  autoBid: { enabled: boolean; budget: number; maxBid: number; withinSec: number; copies: number };
}
export interface AccountParams {
  autoClaim: boolean;
  autoOpenFreePack: string | null;
}
export interface TradeParams {
  mode: 'preview' | 'auto';
  rooms: number[] | null;
  maxAgeMin: number;
  message: string;
  give: { keep: number; rarities: Rarity[]; exclude: number[] };
  seek: { enabled: boolean; wishMinPct: number; wishMaxPct: number; allowChakra: boolean; markupPct: number };
  offer: { enabled: boolean; payWithCards: boolean; payWithChakra: boolean; minPayPct: number; maxPayPct: number; maxChakra: number; maxCards: number; onlyMissing: boolean };
  limits: { maxPending: number; maxPerHour: number; perUserHours: number; expireMin: number; budget: number };
}
export type MonitorInput =
  | { kind: 'auctions'; name: string; enabled: boolean; intervalSec: number; params: AuctionParams }
  | { kind: 'account'; name: string; enabled: boolean; intervalSec: number; params: AccountParams }
  | { kind: 'trades'; name: string; enabled: boolean; intervalSec: number; params: TradeParams };
export type MonitorState = 'running' | 'stopped' | 'paused' | 'error' | 'needs-session';
export interface MonitorStatus {
  state: MonitorState;
  startedAt: string | null;
  lastRunAt: string | null;
  lastOkAt: string | null;
  lastError: string | null;
  ticks: number;
  reserved: number;
  autoBid: { budget: number; maxBid: number; copies: number } | null;
  autoBidBlockedReason: string | null;
  copies: { won: number; leading: number; target: number | null } | null;
  autoBidHalted: boolean;
  trades: { mode: 'preview' | 'auto'; pending: number; sent: number; accepted: number; declined: number; expired: number; halted: boolean } | null;
  tradeBlockedReason: string | null;
  history: Array<{ at: string; ok: boolean; ms: number; error?: string }>;
}
export type Monitor = MonitorInput & { id: string; createdAt: string; updatedAt: string; status: MonitorStatus };

export interface CollectionResponse {
  entries: CollectionEntry[];
  stats: CollectionStats;
}

export interface PriceHistory extends PriceStats {
  lastSales: Array<{ price: number; at?: string }>;
}

export interface FeedEntry {
  userId: string;
  pseudo: string;
  characterId: number;
  name: string;
  series: string;
  rarity: Rarity;
  at: string;
  image?: string;
  godPack?: boolean;
}
