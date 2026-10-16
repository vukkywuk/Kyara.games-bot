import { AccountEndpoints } from './endpoints/account.js';
import { CatalogEndpoints } from './endpoints/catalog.js';
import { MarketEndpoints } from './endpoints/market.js';
import { TradeEndpoints } from './endpoints/trades.js';
import type { KyaraHttpClient } from './KyaraHttpClient.js';

/** Typed facade over every endpoint the bot knows about. */
export class KyaraApi {
  readonly catalog: CatalogEndpoints;
  readonly account: AccountEndpoints;
  readonly market: MarketEndpoints;
  readonly trades: TradeEndpoints;

  constructor(readonly http: KyaraHttpClient) {
    this.catalog = new CatalogEndpoints(http);
    this.account = new AccountEndpoints(http);
    this.market = new MarketEndpoints(http);
    this.trades = new TradeEndpoints(http);
  }
}
