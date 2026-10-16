# Kyara.games bot

A Windows desktop app (plus a browser extension and a CLI) for **your own**
[Kyara.games](https://kyara.games) account: browse all 6,700+ characters, track your
collection and missions, watch and bid on the market, answer trade requests from the market
chat, open packs, and run careful monitors in the background.

```
 your browser (logged in to kyara.games)          your computer
 ┌──────────────────────────────┐   signed,      ┌───────────────────────────────┐
 │ Kyara Bridge extension        │── loopback ──▶ │ kyara serve  (127.0.0.1 only) │──▶ kyara.games/api
 │ reads kyara_token/pass/device │   only         │  ├ /bridge   extension        │
 └──────────────────────────────┘                │  ├ /app-api  web app          │
                                                  │  └ /         web app (React)  │
                                                  └───────────────────────────────┘
```

You log in to Kyara and pass its Cloudflare checks **yourself**: in the app's own Kyara
window, or in your normal browser with the extension. The bot only reads the session the site
already stored and keeps itself in sync. Nothing here solves, skips or hides from Cloudflare.

> Kyara has no official public API. Endpoints were reverse-engineered from the site's own
> frontend; see [docs/api-reference.md](docs/api-reference.md) for what is confirmed and
> what is inferred. Use it within Kyara's rules, on your own account.

## Desktop app (recommended)

```bash
npm install
npm run desktop:dist      # → desktop/release/Kyara Bot Setup 0.3.0.exe
```

Run the installer, then start **Kyara Bot** from the Start menu. The first launch shows a short
setup:

1. **Open Kyara and log in**: a normal Kyara window opens inside the app. Log in as usual; the
   bot picks up your session within a few seconds. No extension needed.
2. **Choose what runs**: daily chores (claim rewards, open free packs) and chat trades in preview.
3. **Spending stays off** until you allow it in **Settings**. You can also start the app with
   Windows from there.

Closing the window keeps the bot running in the tray (right-click the icon to pause all
automation, open Kyara, or quit). Notifications tell you when you win an auction, a trade is
sent or accepted, or something needs you.

**About packs.** The bot does what the site does. While Kyara has its Cloudflare Turnstile
check off (`/api/auth/providers` returns `"turnstile": null`, as since October 2026), packs
open in the background like everything else. When Kyara turns the check on, opening packs needs
its anti-bot pass, which Kyara renews only while its page is open and visible. Packs then get
opened while you have the Kyara window (or a kyara.games tab) on screen, and free packs pile up
in the meantime, up to their cap. Claims, bids and trades run in the background either way.

The installer is not code-signed, so Windows SmartScreen may warn the first time
(**More info → Run anyway**). Data lives in `%APPDATA%\Kyara Bot\data`.

To try it without installing: `npm run desktop:dev` (uses the repository's `.kyara` and `.env`).

## Requirements (development, CLI, extension)

- Node.js ≥ 22 (tested with 22.21)
- Chrome, Edge or Brave (for the extension, optional with the desktop app)
- Optional: Playwright's Chromium (`npm run browser:install`), only for the browser tests and the CLI's browser login

## Install and build

```bash
npm install
cp .env.example .env      # optional; every setting has a default
npm run build             # server (dist/), web app (web/dist/), extension (extension/dist/)
```

## Start the app from a terminal

```bash
npm run serve             # same as: npx tsx src/cli/bin.ts serve
```

Open **http://127.0.0.1:47321**. The server listens on your own computer only. Stop it
with Ctrl+C (monitors and live connections are shut down cleanly). Use `--port` to change
the port.

## Load the extension (Chrome, Edge or Brave)

Optional with the desktop app; use it if you prefer to stay logged in from your own browser.

1. `npm run ext:build` (already done by `npm run build`).
2. Open `chrome://extensions` (Edge: `edge://extensions`, Brave: `brave://extensions`) and turn on **Developer mode**.
3. **Load unpacked** and select the `extension/dist` folder.
4. Pin **Kyara Bridge** to the toolbar.

## Pair it with the bot

1. With `npm run serve` running, open the app → **Session & bridge** → **Create pairing code**.
2. Click the extension icon, type the 8-character code, **Pair with the bot**.
   (If you changed the port, set it under *Advanced* in the popup.)
3. Open https://kyara.games and log in as usual. Within a few seconds the app shows your
   account, and the popup shows **Logged in as …** and the pack pass validity.

The pack pass (needed to open packs) lasts about 30 minutes, and Kyara renews it while its
tab is **visible**. Keep a kyara.games tab open; if it sits in the background for long, the
popup tells you to bring it to the front for a moment.

Revoke a browser any time: **Unpair** in the popup, **Revoke** in the app, or
`npx tsx src/cli/bin.ts bridge unpair <id>`.

### Without the extension (fallback)

```bash
npm run dev -- session import                                  # paste kyara_token (hidden input)
npm run dev -- session import-pass --device-id <kyara_device>  # paste kyara_pass
```

Copy the values from DevTools on kyara.games (Application → Local Storage).

## What you can do in the app

| Section | What it does | Data |
|---|---|---|
| **Dashboard** | Chakra (and chakra reserved in bids), free packs and next refill, Mythic guarantee, golden pack, collection by rarity, missions, latest cards, auctions ending soon, automation activity | live from Kyara |
| **Missions** | Daily, weekly, streak, achievements; claim rewards (spends nothing) | live |
| **Characters** | Virtualised grid of the whole catalogue: search by name, native name or ID; filters by rarity, series, power, aura, owned/missing; sort; detail drawer with drop chance per pack and market prices. Filters live in the URL | live |
| **My collection** | Your cards, completion by rarity, series closest to completion, duplicates | live |
| **Market** | Listings with filters and live countdowns, listing detail with recent sales, **bid** and **buy** after a confirmation that shows Kyara's exact cost; your activity | live |
| **Trades** | Trades you sent (by hand or by a monitor) and received, give/get with card art, cancel a pending one | live |
| **Packs** | Every pack with what it costs you now, odds per rarity, **open ×1/×5/×10**, the reveal (only after Kyara confirms), opening history | live |
| **Monitors** | Market, chat-trade and account monitors with real status and run history: capped auto-bid with a copies target, trade answers (preview or send), auto-claim and free-pack opening, a kill switch | runs in the server |
| **Session & bridge** | Session (never shows credentials), the app's Kyara window, pass validity, paired browsers, pairing, server and API health | |
| **Settings** | Spending limits: per action, automatic bidding, sending trades (a raise always asks first); start with Windows | |
| **Activity** | Every action with its outcome (resolve unknown ones), live events, redacted server logs | |

Anything that spends chakra asks first. The dialog shows the summary and cost computed by
the server's own checks, then a single guarded request is sent. If Kyara does not confirm
in time, the action is marked **unknown** and is never retried automatically; resolve it in
**Activity** after checking your account.

## Command line

Everything is also available from the terminal (`npm run dev -- <command>`, or
`node dist/cli/bin.js <command>` after a build, or `npm link` for a global `kyara`).

| Group | Commands | Session |
|---|---|---|
| `serve` | run the app, app API and bridge (`--port`, `--dev-origin`) | – |
| `bridge` | `status`, `unpair <id\|all>` | – |
| `session` | `login [--allow-guest]`, `import`, `import-pass [--device-id]`, `status [--offline]`, `logout [--wipe-browser]` | – |
| `characters` | `search <text>`, `list`, `show <id>`, `series` with filters and sorting | no |
| `account` | `me`, `wishlist` | yes |
| `collection` | `list [--dupes]`, `stats`, `missing`, `snapshot`, `diff [--save]` | yes |
| `packs` | `list`, `rates [pack]`, `pool <pack>`, `quote <pack> [-c N]`, **`open <pack> [-c N] [--resume id]`** | open/quote: yes |
| `market` | `list`, `show <id>`, `prices <charId>`, `orders <charId>`, `offers`, `mine`, **`bid <id> <max>`**, **`buy <id>`** | bid/buy/mine: yes |
| `progress` | `show`, **`claim [all\|streak\|series\|achievement] [id]`** | yes |
| `leaderboard`, `feed`, `reviews`, `news`, `status` | public information | no |
| `monitor` | `auctions`, `account`, `collection` (terminal versions of the app's monitors) | varies |
| `actions` | `list`, `show <id>`, `resolve <id> --as succeeded\|failed` | – |
| `api` | `verify [--shapes]` (GET only), `get <path>` | optional |

**Bold** commands change account state; they accept `--dry-run`, `--yes` and `--force-budget`.
Exit codes: `0` ok, `1` failure, `2` usage, `3` login, `4` rate limited, `5` outcome unknown,
`6` refused by a safeguard, `7` network.

## Configuration (`.env`)

Spending limits are set in the app (**Settings**). The variables below are for developers and
the CLI; a spending variable set in `.env` overrides the app and shows as locked there.

| Variable | Default | Meaning |
|---|---|---|
| `KYARA_BASE_URL` | `https://kyara.games` | Site URL |
| `KYARA_DATA_DIR` | `.kyara` | Session, pairing, monitors, journal, cache (git-ignored) |
| `KYARA_TOKEN` | – | Optional token override (never written to disk) |
| `KYARA_TIMEOUT_MS` | `15000` | Per-request timeout |
| `KYARA_MAX_RETRIES` | `3` | Retries for **read** requests only |
| `KYARA_MIN_INTERVAL_MS` | `250` | Minimum spacing between requests to Kyara |
| `KYARA_HEADLESS` | `false` | Bot browser (CLI login only) |
| `KYARA_LOG_LEVEL` / `KYARA_LOG_FORMAT` | `info` / `pretty` | |
| `KYARA_MAX_SPEND_PER_ACTION` | `500` | Refuse actions that may spend more chakra |
| `KYARA_AUTO_BID_ENABLED` / `_BUDGET` / `_MAX` | `false` / `0` / `0` | Master switch and caps for automatic bidding |
| `KYARA_AUTO_TRADE_ENABLED` / `_BUDGET` | `false` / `0` | Lets trade monitors send trades; chakra allowed in pending trades (0 = cards only) |

## Development

```bash
npm run serve -- --dev-origin http://localhost:5173   # API + bridge for the dev server
npm run web:dev                                       # Vite with hot reload on :5173 (proxies /app-api)
npm run ext:build                                     # rebuild the extension, then "reload" it in chrome://extensions

npm run desktop:dev                                   # build and start the desktop app
npm run desktop:dist                                  # Windows installer in desktop/release

npm run typecheck   # server, web app, extension and desktop app
npm run lint
npm test            # unit, server, bridge security, React components (no network)
npm run test:e2e    # Chromium: extension end to end, web app smoke test, read-only site check
npm run build
```

The tests never send a purchase, bid, opening or claim to the real site. The end-to-end
tests mock Kyara (or block every write when they load the real page).

## Troubleshooting

- **The app says "Bot offline"**: `npm run serve` is not running, or runs on another port.
- **Desktop app: "Another Kyara bot is already running"**: `npm run serve` is running in a terminal. Stop it; the app is the server.
- **Trade monitor only previews**: allow **Sending trades automatically** in Settings and set the monitor to *Send trades*.
- **"Kyara wants its anti-bot pass"** (bids or trades): Kyara asked for the pass on this account. Open the Kyara window (or a kyara.games tab) for a moment; the bot retries on its next check.
- **Popup: "Not reachable on port 47321"**: start `npm run serve`; if you use another port, set it in the popup under *Advanced* and pair again.
- **Popup: "Pairing revoked"**: the pairing was removed in the app or CLI. Create a new code and pair again.
- **"No pack pass" / packs cannot be opened**: keep kyara.games open and logged in, and bring the tab to the front for a few seconds. Kyara renews the pass only while its tab is visible.
- **Popup: "Different account than this tab"**: the bot holds a token you imported for another account. Log out from the bot (`session logout`) and let the extension sync, or log in to the right account on kyara.games.
- **An action shows "unknown"**: Kyara did not confirm in time. Check your account on kyara.games, then mark it in **Activity**. Pack openings can be re-sent safely with `packs open <id> --resume <action id>`.
- **"Rate limited"**: the bot already slows down; wait a minute. Do not lower `KYARA_MIN_INTERVAL_MS`.
- **"Unexpected response shape"**: Kyara changed its API. Run `npm run dev -- api verify --shapes` and update `src/api/schemas/*`.

## Security and limits

- The server binds to 127.0.0.1 and checks Host, Origin and a per-run app token; the bridge
  uses one-time pairing and signed requests. Details and the trust boundary:
  [docs/bridge-security.md](docs/bridge-security.md).
- Local software running under your OS account can read the bot's data directory and your
  browser profile; the bridge does not protect against malware already on the machine.
- Tokens, passes, pairing secrets and authorization headers are redacted from every log,
  event and error. `.env`, `.kyara/` and build outputs are git-ignored.
- The bot never accepts or declines a trade for you, never writes in the chat, and only offers
  spare copies in trades Kyara's own fair-play check calls fair. Selling, buy orders,
  recycling and social features are known but not implemented (see the API reference).
- The desktop app's Kyara window is a plain browser window: no visibility tricks, no
  user-agent changes, nothing injected into Kyara's page. The app reads three localStorage
  values from an isolated script context, as the extension does.

## Documentation

- [docs/bridge-security.md](docs/bridge-security.md): extension, pairing, signatures, trust boundary
- [docs/architecture.md](docs/architecture.md): components and responsibilities
- [docs/automation.md](docs/automation.md): safeguards, monitors, auto-bid and auto-trade rules
- [docs/api-reference.md](docs/api-reference.md): Kyara endpoint inventory with verification status
- [docs/implementation-checklist.md](docs/implementation-checklist.md): what is done and verified
