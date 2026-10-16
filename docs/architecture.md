# Architecture

```
src/
  cli/            Commander CLI: parsing, prompts, output. No business rules.
    commands/     one file per command group
  bot.ts          composition root: builds every component from config
  index.ts        library exports
  config/         .env + environment → validated KyaraConfig (zod)
  api/
    transport.ts        Transport interface + FetchTransport (Node fetch)
    KyaraHttpClient.ts  the only HTTP entry point
    KyaraApi.ts         typed facade
    endpoints/          catalog (public), account (session), market
    schemas/            zod schemas: common, public (CONFIRMED), account (INFERRED), market
  auth/
    SessionStore.ts     token + device id + pack pass on disk (0600, atomic, git-ignored)
    SessionManager.ts   login via browser, token import, status, logout
    PassManager.ts      Turnstile-backed "pass" needed to open packs
  browser/
    BrowserManager.ts      persistent Chromium profile, localStorage access, human waits, diagnostics
    TurnstileVerifier.ts   renders the official Turnstile widget for a human to complete
    BrowserTransport.ts    Transport that runs fetch() inside the Kyara page
  modules/        business logic, one per domain
    CharacterModule, AccountModule, CollectionModule, PackModule (+ packPricing), MarketModule, ProgressModule
  services/
    ActionGuard.ts       the pipeline every state-changing action goes through
    ActionJournal.ts     append-only JSONL log of actions and their outcomes
    Poller.ts            bounded polling loop
    AuctionMonitor.ts, AccountWatcher.ts, CollectionTracker.ts, Notifier.ts
  utils/          errors, logger, redaction, time
```

## Hybrid HTTP / browser design

Investigation showed the API is a plain JSON API with **bearer-token** auth and no
anti-bot check on ordinary requests. Direct HTTP is therefore the default for
everything. The browser is used only where a human or a real browser is needed:

| Need | Why a browser | Component |
|---|---|---|
| Logging in | Discord OAuth; the site stores the token in `localStorage` | `SessionManager.loginWithBrowser` |
| Opening packs | The server needs a pass, which needs a Cloudflare Turnstile token | `PassManager` + `BrowserTurnstileVerifier` |
| Fallback transport | If direct HTTP is ever blocked | `BrowserTransport` (`--via-browser`) |

Business modules depend only on `KyaraApi`, which depends on `KyaraHttpClient`, which
depends on the `Transport` interface. Switching from direct HTTP to in-page requests
is a constructor argument. Throttling, validation and safety guards behave the same
either way.

## Request pipeline (`KyaraHttpClient`)

1. Builds headers: `x-device-id` always, `authorization: Bearer` only when the endpoint needs or accepts auth.
2. Queues the request. Requests run one at a time, spaced by `KYARA_MIN_INTERVAL_MS`. When `x-ratelimit-remaining` drops below 2% of the limit, the queue pauses until the reset.
3. Sends through the transport with a timeout.
4. Maps the outcome: 2xx → zod validation (`SchemaMismatchError` on drift); 401 → `AuthRequiredError` and the stored session is marked invalid; 429 → `RateLimitedError` with `retry-after`; others → `KyaraApiError(status, code)`. Network failures → `NetworkError`, flagged when the request provably never left.
5. **GET** only: bounded retries (default 3) for network errors, 502/503/504, `catalog_loading`, and 429 with a reasonable `retry-after`. Exponential backoff with jitter.
6. **Mutations are never retried by the client.**

## State-changing actions (`ActionGuard`)

Every write (open packs, bid, buy, claim) is declared as an `ActionSpec` and run by the guard:

```
validate input
→ per-action budget (KYARA_MAX_SPEND_PER_ACTION)
→ in-process "already running" check
→ journal: refuse if an identical action is pending/unknown, or succeeded within its cooldown
→ preflight (fresh server state: balance, availability, limits, listing status)
→ budget again (the cost is often only known after preflight)
→ dry-run stops here
→ confirmation prompt (or --yes)
→ cross-process lock file
→ journal "pending" → execute once → journal "succeeded" / "failed" / "unknown"
```

An outcome is **unknown** when the server might have applied the change: timeouts,
dropped connections, 5xx (except the 503 gate codes), or a 2xx we could not parse.
Unknown actions block identical actions until you resolve them (`kyara actions resolve`).
Pack openings carry the site's idempotency key, so they can be resumed safely with
`--resume`; actions without a key must be checked manually.

## Session storage

`.kyara/session.json` (git-ignored, mode 0600) stores the token, the device id, a short
summary of the account, and the current pack pass. `KYARA_TOKEN` in the environment
overrides it and is never written to disk. Every loaded secret is registered with the
redactor, so it is masked in all log lines and error messages, even inside free text.

`.kyara/browser-profile/` is the dedicated Chromium profile (your Discord login lives
there). `kyara session logout --wipe-browser` deletes it.

## Monitoring

`poll()` runs a task on an interval with a hard floor that the CLI cannot lower (30 s
auctions, 2 min account and collection). It adds jitter, backs off exponentially on
errors (up to 15 min), stops on auth errors, stops after a maximum duration, and stops
cleanly on Ctrl+C. Monitors only notify unless automation is explicitly enabled; see
`docs/automation.md`.

## Local server, bridge and web app (v0.2)

```
extension/                 Chrome/Edge MV3 extension (built to extension/dist)
  src/content.ts           kyara.games only: reads kyara_token / kyara_device / kyara_pass
  src/background.ts        pairing, signed calls to the bridge, dedup by fingerprints
  src/syncPolicy.ts        pure "send what, when" decision (unit-tested)
  src/popup.*              status and pairing UI
src/bridge/protocol.ts     shared by extension and server: signing, fingerprints, types
src/server/
  KyaraServer.ts           one loopback HTTP server: /bridge, /app-api, static web app, SSE
  BridgeService.ts         pairing codes, client registry (.kyara/bridge.json), HMAC auth, sync
  AppApi.ts                the web app's API: thin routes onto the existing modules and ActionGuard
  MonitorService.ts        runs AuctionMonitor / AccountWatcher loops with persisted config and real status
  EventHub.ts              live events (SSE) and a redacted log ring buffer
web/                       React 19 + Vite + Tailwind 4 + Motion + TanStack Query/Virtual
  src/lib/                 typed API client (app token in memory), event stream, query hooks
  src/components/          design primitives, overlays, the collectible card, app shell
  src/pages/               Dashboard, Missions, Characters, Collection, Market, Packs, Monitors, Session, Activity
```

**One session manager.** The extension never talks to Kyara for the bot. It pushes what the
site stored to the bridge, and `SessionManager.applyBridgeSync` (serialised with a mutex,
like CLI imports and logout) validates and stores it. Other parts subscribe to session
changes via `SessionStore.onChange`; the store also reloads when another process (the CLI)
rewrites `session.json`.

**No second business layer.** The web app only calls `/app-api`, which calls the same
modules the CLI uses (`CharacterModule`, `PackModule`, `MarketModule`, `ProgressModule`…).
Writes are two-step: `{ dryRun: true }` runs every check and returns the guard's own
summary and cost for the confirmation dialog; `{ confirm: true }` runs the guarded action
once. Claiming rewards is the exception: it spends nothing, so the app (like the CLI)
claims in one click, still through the guard and journal.

**Types are shared, logic mostly too.** `web/src/lib/types.ts` imports domain types from
`src/api/schemas/*` (type-only). Character search (`src/modules/characterSearch.ts`) is
the same code in the CLI and the browser.

**One account at a time.** A browser logged into a *different* Kyara account than the bot's
never replaces the bot's session silently: the sync is refused with an explanation, and
you switch with **Forget this session** (which also pauses automation).

**Monitors are honest.** A monitor's state is `running` only while its poll loop is alive.
Stopping waits for a tick in flight, and every automatic bid, claim or opening re-checks
that its monitor is still active right before acting, so the kill switch cannot be outrun.
Monitors waiting for a session restart by themselves when one arrives.
Errors back off and are recorded per run; an auth failure stops the loop with
`needs-session`; the kill switch stops every loop and persists.

## Trades and the desktop app (v0.3)

- `api/endpoints/trades.ts`: market chat (read only), my trades, tradeable/owned cards of a
  player, fair-play limits and reference prices, propose and cancel.
- `modules/tradeFairness.ts` (port of the site's fair/gift/over verdict) and
  `modules/tradePlanner.ts` (what to give and ask for). Both are pure and unit-tested.
- `modules/TradeModule.ts` sends proposals through the `ActionGuard` with a fresh preflight
  (spare copies, balance, fair-play).
- `services/TradeMonitor.ts` reads the chat, plans and sends within limits, follows outcomes
  and cancels stale proposals. `MonitorService` runs it as the `trades` monitor kind and
  persists its progress.
- `auth/PassManager.withStoredPass` attaches the stored pass to bids, buys and proposals like
  the site, and turns `pass_required` into a clear, definite refusal.
- `config/SettingsStore.ts`: spending limits in `settings.json`, applied onto the live
  config; `.env` values win and are reported as locked.
- `desktop/main.ts` (Electron): starts `KyaraServer` in-process (data in
  `%APPDATA%/Kyara Bot/data`), shows the web app, tray, start with Windows, notifications
  from the `EventHub`, and the Kyara window session sync. `desktop/preload.ts` exposes four
  calls to the web app (`web/src/lib/desktop.ts`). Built by `scripts/build-desktop.mjs`;
  `electron-builder` makes the NSIS installer.

### Web app design system

- **Identity from the subject.** Kyara's own rarity colours and seal kanji (常 珍 稀 叙 伝 神)
  and each pack's kanji and colour carry all the colour; chrome is indigo ink (`#0f1424`
  family) with washi text (`#ede8de`). Primary buttons are paper on ink, so no accent
  competes with rarity.
- **Type.** Unbounded (Kyara's display face) for titles and numbers, Zen Kaku Gothic New for
  UI text and Japanese names; tabular numerals for every figure. Fonts are bundled
  (`@fontsource`), so the CSP can stay `font-src 'self'`.
- **The collectible card** is the one bold element: full-bleed 2:3 art with a reserved
  aspect ratio (no layout shift), a hanko-style rarity seal, the native name set
  vertically, a rarity rule along the bottom edge.
- **Tokens** live in `web/src/styles/app.css` (`@theme`): colours, type scale, radius
  hierarchy (chip 3px < control 6px < panel 8px), shadow, easing, breakpoints. Durations:
  140/220/360 ms.
- **Motion** (Motion for React, `MotionConfig reducedMotion="user"`): short cross-fade
  between kept-alive pages, sliding indicators for tabs and navigation, spring toggles,
  drawers and dialogs from their edge, the detail art settling in as the drawer opens, list
  enter/exit for chips, events and monitors, and one orchestrated moment: the pack reveal
  (after Kyara's confirmation, skippable, instant under reduced motion). Transform and
  opacity only.
- **Continuity.** Visited pages stay mounted, each seeing its own frozen location while
  hidden (so a hidden page never reacts to another section's URL); filters live in the URL and sidebar links
  restore each section's last filters; scroll position is kept per section; the
  catalogue is fetched once and searched locally; images fade in over a placeholder of the
  same size.
