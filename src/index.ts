/** Library entry point: everything the CLI uses is available programmatically. */
export { createKyaraBot } from './bot.js';
export type { KyaraBot, BotOverrides } from './bot.js';
export { loadConfig, loadDotEnv } from './config/config.js';
export type { KyaraConfig } from './config/config.js';

export { KyaraHttpClient, buildQuery } from './api/KyaraHttpClient.js';
export { KyaraApi } from './api/KyaraApi.js';
export { FetchTransport, TransportFailure } from './api/transport.js';
export type { Transport, TransportRequest, TransportResponse } from './api/transport.js';
export * from './api/schemas/common.js';
export * from './api/schemas/public.js';
export * from './api/schemas/account.js';
export * from './api/schemas/market.js';

export { SessionStore } from './auth/SessionStore.js';
export { SessionManager } from './auth/SessionManager.js';
export { PassManager } from './auth/PassManager.js';
export { BrowserManager } from './browser/BrowserManager.js';
export { BrowserTransport } from './browser/BrowserTransport.js';
export { BrowserTurnstileVerifier } from './browser/TurnstileVerifier.js';
export type { HumanVerifier } from './browser/TurnstileVerifier.js';

export { CharacterModule, filterCharacters, normalize } from './modules/CharacterModule.js';
export { AccountModule, summariseWallet } from './modules/AccountModule.js';
export { CollectionModule, computeStats, joinCollection } from './modules/CollectionModule.js';
export { PackModule } from './modules/PackModule.js';
export { packAccess, quoteOpen, maxOpenable } from './modules/packPricing.js';
export { MarketModule, applyListingFilter, checkBiddable, checkBuyable } from './modules/MarketModule.js';
export { ProgressModule, listClaimables } from './modules/ProgressModule.js';

export { ActionGuard, isAmbiguous } from './services/ActionGuard.js';
export { ActionJournal } from './services/ActionJournal.js';
export { AuctionMonitor } from './services/AuctionMonitor.js';
export { AccountWatcher } from './services/AccountWatcher.js';
export { CollectionTracker, diffCollections } from './services/CollectionTracker.js';
export { poll } from './services/Poller.js';
export { ConsoleNotifier, MemoryNotifier } from './services/Notifier.js';
export type { Notifier, BotEvent } from './services/Notifier.js';

export * from './utils/errors.js';
export { createLogger } from './utils/logger.js';
export { redact, redactString } from './utils/redact.js';
