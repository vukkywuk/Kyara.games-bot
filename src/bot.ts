import path from 'node:path';
import { KyaraApi } from './api/KyaraApi.js';
import { KyaraHttpClient } from './api/KyaraHttpClient.js';
import type { HttpClientOptions } from './api/KyaraHttpClient.js';
import type { Transport } from './api/transport.js';
import { PassManager } from './auth/PassManager.js';
import { SessionManager } from './auth/SessionManager.js';
import { SessionStore } from './auth/SessionStore.js';
import { BrowserManager } from './browser/BrowserManager.js';
import { BrowserTransport } from './browser/BrowserTransport.js';
import { BrowserTurnstileVerifier } from './browser/TurnstileVerifier.js';
import type { HumanVerifier } from './browser/TurnstileVerifier.js';
import type { KyaraConfig } from './config/config.js';
import { AccountModule } from './modules/AccountModule.js';
import { CharacterModule } from './modules/CharacterModule.js';
import { CollectionModule } from './modules/CollectionModule.js';
import { MarketModule } from './modules/MarketModule.js';
import { TradeModule } from './modules/TradeModule.js';
import { SettingsStore } from './config/SettingsStore.js';
import { PackModule } from './modules/PackModule.js';
import { ProgressModule } from './modules/ProgressModule.js';
import { ActionGuard } from './services/ActionGuard.js';
import { ActionJournal } from './services/ActionJournal.js';
import { CollectionTracker } from './services/CollectionTracker.js';
import type { Logger } from './utils/logger.js';
import { createLogger } from './utils/logger.js';

export interface BotOverrides {
  logger?: Logger;
  /** Replace the network layer (tests, or 'browser' to route API calls through the page). */
  transport?: Transport | 'browser';
  /** Replace how Turnstile tokens are obtained (tests). */
  verifier?: HumanVerifier;
  sleep?: (ms: number) => Promise<void>;
}

export interface KyaraBot {
  config: KyaraConfig;
  log: Logger;
  http: KyaraHttpClient;
  api: KyaraApi;
  store: SessionStore;
  session: SessionManager;
  passes: PassManager;
  journal: ActionJournal;
  guard: ActionGuard;
  characters: CharacterModule;
  account: AccountModule;
  collection: CollectionModule;
  packs: PackModule;
  market: MarketModule;
  trades: TradeModule;
  settings: SettingsStore;
  progress: ProgressModule;
  tracker: CollectionTracker;
  /** Lazily created browser (only when a workflow really needs one). */
  browser(): BrowserManager;
  /** Releases the browser and any other resources. Safe to call twice. */
  close(): Promise<void>;
}

export function createKyaraBot(config: KyaraConfig, overrides: BotOverrides = {}): KyaraBot {
  const log = overrides.logger ?? createLogger({ level: config.logLevel, format: config.logFormat });
  const store = new SessionStore(config.paths.session, config.tokenOverride);

  let browser: BrowserManager | null = null;
  const getBrowser = (): BrowserManager =>
    (browser ??= new BrowserManager({
      baseUrl: config.baseUrl,
      profileDir: config.paths.browserProfile,
      diagnosticsDir: config.paths.diagnostics,
      headless: config.headless,
      logger: log.child('browser'),
    }));

  const httpOptions: Omit<HttpClientOptions, 'credentials'> = {
    baseUrl: config.baseUrl,
    transport: overrides.transport === 'browser' ? new BrowserTransport(getBrowser()) : overrides.transport,
    timeoutMs: config.timeoutMs,
    maxRetries: config.maxRetries,
    minIntervalMs: config.minIntervalMs,
    logger: log.child('http'),
    sleep: overrides.sleep,
  };
  const http = new KyaraHttpClient({
    ...httpOptions,
    credentials: {
      getToken: () => store.token(),
      getDeviceId: () => store.deviceId(),
      onUnauthorized: () => store.markInvalid(),
    },
  });
  const api = new KyaraApi(http);

  const journal = new ActionJournal(config.paths.journal);
  // in-app spending limits (settings.json), applied onto the live config; .env values win
  const settings = new SettingsStore(path.join(config.dataDir, 'settings.json'), config);
  const guard = new ActionGuard(journal, log.child('action'), () => config.maxSpendPerAction, path.join(config.dataDir, 'action.lock'));

  const passes = new PassManager(
    api,
    store,
    async () => {
      if (overrides.verifier) return { verifier: overrides.verifier, close: async () => undefined };
      const b = getBrowser();
      return { verifier: new BrowserTurnstileVerifier(b, log.child('turnstile')), close: () => b.close() };
    },
    log.child('pass'),
  );

  const characters = new CharacterModule(api, config.paths.cache, log.child('characters'));
  const session = new SessionManager(store, api, httpOptions, log.child('session'), getBrowser, config.paths.browserProfile);

  return {
    config,
    log,
    http,
    api,
    store,
    session,
    passes,
    journal,
    guard,
    settings,
    characters,
    account: new AccountModule(api),
    collection: new CollectionModule(api, characters),
    packs: new PackModule(api, guard, journal, passes, log.child('packs')),
    market: new MarketModule(api, guard, passes),
    trades: new TradeModule(api, guard, passes),
    progress: new ProgressModule(api, guard),
    tracker: new CollectionTracker(config.paths.snapshots),
    browser: getBrowser,
    close: async () => {
      const b = browser;
      browser = null;
      if (b) await b.close();
    },
  };
}
