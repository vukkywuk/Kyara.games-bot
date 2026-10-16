# Architecture

One Node process holds the Kyara session and talks to Kyara: `kyara serve` from the CLI, or
the desktop app's main process, which runs the same server. Everything else is a client of
that process:

```
desktop app: Kyara window ─(in-process read of localStorage)─┐
browser extension ─(signed, 127.0.0.1)── /bridge ────────────┤
web app ──────────────────(127.0.0.1)── /app-api ────────────┼─▶ modules + ActionGuard ─▶ kyara.games/api
CLI commands ─────────────(same process, no server) ─────────┘
```

## Source layout

```
src/
  bot.ts            composition root: builds every component from the config
  index.ts          library exports
  cli/              Commander CLI, one file per command group; no business rules
  config/           config.ts (.env + environment -> KyaraConfig), SettingsStore.ts (in-app limits)
  api/              Transport, KyaraHttpClient, KyaraApi facade
    endpoints/      catalog (public), account, market, trades
    schemas/        zod schemas, each marked CONFIRMED or INFERRED
  auth/             SessionStore (file), SessionManager (all session changes), PassManager
  browser/          Playwright: CLI login, Turnstile widget, in-page transport
  modules/          domain logic: characters, account, collection, packs, market, progress, trades
                    packPricing, tradeFairness: ports of the site's own rules (pure)
                    tradePlanner: pure; characterSearch, progressView: pure, shared with the web app
  services/         ActionGuard, ActionJournal, Poller, the monitors, Notifier
  server/           KyaraServer, AppApi, BridgeService, MonitorService, EventHub
  bridge/protocol.ts  shared by server and extension: signing, fingerprints, message types
  utils/            errors, logger, redaction, time, mutex
web/                React 19 + Vite + Tailwind 4 + Motion + TanStack Query/Virtual
extension/          Kyara Bridge (Chrome MV3)
desktop/            Electron main process and preload
scripts/            builds for the extension and the desktop app, generated icons
tests/              Vitest: unit, server, bridge security, React components; opt-in e2e
```

## HTTP first, browser only where needed

Kyara's API is a plain JSON API with bearer-token auth and no anti-bot check on ordinary
requests, so direct HTTP is the default. A browser is involved only where a human is:

| Need | How | Component |
|---|---|---|
| Logging in | Discord OAuth; the site stores its token in `localStorage` | the desktop Kyara window, the extension, or `SessionManager.loginWithBrowser` (CLI) |
| Pack pass, while Kyara enables Turnstile | The pass needs a Turnstile token from a real browser | synced from the user's browser; `PassManager` + `BrowserTurnstileVerifier` on request |
| Fallback transport | If direct HTTP is ever blocked | `BrowserTransport` (`--via-browser`) |

Modules depend on `KyaraApi`, which depends on `KyaraHttpClient`, which depends on the
`Transport` interface, so switching to in-page requests is a constructor argument.

## Request pipeline (`KyaraHttpClient`)

1. Builds headers: `x-device-id` always, `authorization: Bearer` only when the endpoint needs or accepts auth.
2. Queues the request. Requests run one at a time, spaced by `KYARA_MIN_INTERVAL_MS`. When `x-ratelimit-remaining` drops below 2% of the limit, the queue pauses until the reset.
3. Sends through the transport with a timeout.
4. Maps the outcome: 2xx -> zod validation (`SchemaMismatchError` on drift); 401 -> `AuthRequiredError` and the stored session is marked invalid; 429 -> `RateLimitedError` with `retry-after`; others -> `KyaraApiError(status, code)`. Network failures -> `NetworkError`, flagged when the request provably never left.
5. **GET** only: bounded retries (default 3) for network errors, 502/503/504, `catalog_loading`, and 429 with a reasonable `retry-after`. Exponential backoff with jitter.
6. **Mutations are never retried by the client.**

## State-changing actions (`ActionGuard`)

Every write (open packs, bid, buy, claim, propose or cancel a trade) is declared as an
`ActionSpec` and run by the guard:

```
validate input
-> per-action budget (Settings or KYARA_MAX_SPEND_PER_ACTION)
-> in-process "already running" check
-> journal: refuse if an identical action is pending/unknown, or succeeded within its cooldown
-> preflight (fresh server state: balance, availability, limits, listing status, spare copies)
-> budget again (the cost is often only known after preflight)
-> dry-run stops here
-> confirmation prompt (or --yes)
-> cross-process lock file
-> journal "pending" -> execute once -> journal "succeeded" / "failed" / "unknown"
```

An outcome is **unknown** when the server might have applied the change: timeouts,
dropped connections, 5xx (except the 503 gate codes), or a 2xx that does not parse.
Unknown actions block identical actions until resolved (`kyara actions resolve`). Pack
openings carry the site's idempotency key, so they can be resumed with `--resume`; other
actions must be checked by hand.

## Session

`SessionManager` owns the session. Every change goes through its mutex: CLI login and
import, extension syncs (`applyBridgeSync`), the desktop Kyara window
(`applySiteSnapshot`, same validation) and logout. Rules:

- A token is stored only after `GET /api/me` accepts it. Refused tokens are remembered by
  fingerprint and not re-checked.
- Guest accounts (Kyara creates one for every visitor before login) are never adopted from a
  sync; a guest session stored by an older version is replaced by the real account.
- A browser logged into a different account never replaces the bot's session silently: the
  user switches with **Forget this session**, which also pauses automation.
- A pass is accepted only for the session the bot uses, with more than a minute left.

`SessionStore` keeps the token, device id, account summary and pass in `session.json` in the
data directory (mode 0600, written atomically). `KYARA_TOKEN` overrides it and is never
written. The store reloads when another process (the CLI) rewrites the file, and every
loaded secret is registered with the log redactor.

Data directory: `.kyara/` for the CLI and `desktop:dev`, `%APPDATA%\Kyara Bot\data` for the
installed app, or `KYARA_DATA_DIR`. It also holds `settings.json`, `monitors.json`,
`bridge.json`, `actions.jsonl`, the catalogue cache and the CLI's browser profile.

## Settings

`SettingsStore` keeps the spending limits (per action, auto-bid, auto-trade) in
`settings.json` and applies them onto the live config objects that the guard and monitors
read on every use, so a change takes effect without a restart (running monitors are
restarted to pick it up). A `KYARA_*` variable set in the environment or `.env` wins and is
reported as locked. A change that lets the bot spend more is refused unless the request
carries an explicit confirmation.

## Local server

`KyaraServer` listens on 127.0.0.1 only and serves three surfaces:

- `/bridge/*`: the extension. One-time pairing, then HMAC-signed requests
  ([bridge-security.md](bridge-security.md)).
- `/app-api/*`: the web app, behind Host and Origin checks and a per-run app token sent in a
  custom header. Routes call the same modules as the CLI. Writes are two-step:
  `{ dryRun: true }` returns the guard's own summary and cost for the confirmation dialog,
  then `{ confirm: true }` runs the guarded action once. Claiming rewards spends nothing, so
  the app sends `confirm` directly.
- `/`: the built web app, with a strict CSP. Live events reach it over server-sent events.

The web app imports domain types from `src/api/schemas` (type-only), and runs the same pure
modules as the CLI (`characterSearch`, `progressView`).

## Monitors

`MonitorService` runs three kinds inside the server, with configuration and progress in
`monitors.json`:

- **auctions** (`AuctionMonitor`): notifies on matching listings; optional auto-bid with a
  budget, a maximum and a copies target.
- **account** (`AccountWatcher`): free packs, claimable rewards, newly free packs; optional
  auto-claim and free-only auto-open.
- **trades** (`TradeMonitor`): answers structured chat requests with fair trades
  (`tradePlanner`, `tradeFairness`, `TradeModule`), in preview unless sending is allowed.

Each runs in `poll()`: an interval with a floor the UI and CLI cannot lower (30 s auctions,
60 s trades, 2 min account and collection), jitter, exponential backoff on errors (up to
15 min), a wake-up hint (next auction window, next free pack) and an immediate stop on auth
errors. A monitor shows `running` only while its loop is alive. Stopping waits for a tick in
flight, and every automatic bid, claim, opening or proposal re-checks that its monitor is
still active right before acting, so the kill switch cannot be outrun. Monitors waiting for a
session restart when one arrives. Rules for each kind: [automation.md](automation.md).

## Desktop app

`desktop/main.ts` (Electron, ESM main process) starts `KyaraServer` in-process and shows its
web app in a window locked to the local origin. It adds a tray (closing the window keeps the
bot running), start with Windows, native notifications for selected `EventHub` events, and
the Kyara window: a normal window on kyara.games with its own persistent partition, whose
three localStorage values are read from an isolated world on load, focus and every 15 s.
`desktop/preload.ts` exposes four calls to the web app, each re-checked against the sender.
`scripts/build-desktop.mjs` bundles both with esbuild into `desktop/app`, and
`electron-builder` produces the NSIS installer.

## Web app design

- Colour carries meaning only: Kyara's six rarity colours and seal kanji, and each pack's own
  colour. Chrome is indigo ink with washi text; primary buttons are paper on ink.
- Unbounded for titles and numbers, Zen Kaku Gothic New for UI text and Japanese names,
  tabular numerals for figures. Fonts are bundled so the CSP can stay `font-src 'self'`.
- Tokens (colours, type scale, radii, durations, easing) live in `web/src/styles/app.css`.
- Motion animates transform and opacity only and follows `prefers-reduced-motion`
  (`MotionConfig reducedMotion="user"`). The one orchestrated moment is the pack reveal,
  which runs only after Kyara confirms the opening.
- Visited pages stay mounted, each with its own frozen location while hidden; filters live in
  the URL, and each section keeps its last filters and scroll position.
