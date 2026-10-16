# Kyara.games bot

Automation for **your own** [Kyara.games](https://kyara.games) account: a Windows desktop
app, a local web app, a browser extension and a CLI. It browses the character catalogue,
tracks the collection and missions, bids and buys on the market, opens packs, answers trade
requests from the market chat, and runs monitors in the background.

You log in to Kyara yourself, in the app's Kyara window or in your own browser with the
extension. The bot reads the session the site stored and never solves, skips or hides from
Cloudflare. Kyara has no official API: the endpoints were reverse-engineered from the site's
client ([docs/api-reference.md](docs/api-reference.md) lists what is confirmed and what is
inferred). Use it within Kyara's rules.

## How it fits together

```
desktop app: Kyara window ─(reads localStorage)─────────┐
browser extension ─(paired, signed)── /bridge ──────────┤   local server, 127.0.0.1 only
web app ───────────────────────────── /app-api ─────────┼─▶ session, guarded actions, monitors ─▶ kyara.games/api
CLI ─────────────────────────────────(in process)───────┘
```

One process owns the session and every call to Kyara. Anything that changes the account
goes through one guard: budget checks, a fresh preflight, confirmation, a journal, and no
blind retry. Details: [docs/architecture.md](docs/architecture.md).

## Desktop app

```bash
npm install
npm run desktop:dist      # -> desktop/release/Kyara Bot Setup 0.3.0.exe
```

Run the installer and start **Kyara Bot**. The first launch walks through:

1. **Log in**: a Kyara window opens inside the app. Log in with Discord as usual; the bot
   picks up the session within a few seconds.
2. **Choose what runs**: claim rewards and open free packs, and chat trades in preview.
3. **Spending stays off** until you allow it in **Settings**, where you can also start the
   app with Windows.

Closing the window keeps the bot running in the tray (right-click to pause all automation,
open Kyara, or quit). Notifications report auction wins, trades sent or accepted, and
anything that needs you. Data lives in `%APPDATA%\Kyara Bot\data`.

The installer is not code-signed, so Windows SmartScreen may warn on first run
(**More info -> Run anyway**). `npm run desktop:dev` runs the app from the repository, using
its `.kyara` folder and `.env`.

## Running from source

Requirements: Node.js 22 or later. Chrome, Edge or Brave for the extension. Playwright's
Chromium (`npm run browser:install`) only for the e2e tests and the CLI's browser login.

```bash
npm install
cp .env.example .env      # optional; every setting has a default
npm run build             # server (dist/), web app (web/dist/), extension (extension/dist/)
npm run serve             # http://127.0.0.1:47321 (--port to change)
```

### Connecting your session

Without the desktop app, the session comes from your browser through the **Kyara Bridge**
extension:

1. Open `chrome://extensions` (or `edge://`, `brave://`), enable **Developer mode**, then
   **Load unpacked** and select `extension/dist`.
2. In the app, **Session & bridge -> Create pairing code**. Type the 8-character code in the
   extension popup and choose **Pair with the bot** (set the port under *Advanced* if you
   changed it).
3. Log in on kyara.games. The app shows your account within a few seconds.

Revoke a browser with **Unpair** in the popup, **Revoke** in the app, or
`npm run dev -- bridge unpair <id>`.

Without the extension, paste the values from DevTools on kyara.games (Application -> Local
Storage):

```bash
npm run dev -- session import                                  # kyara_token (hidden input)
npm run dev -- session import-pass --device-id <kyara_device>  # kyara_pass
```

## The app

| Section | What it does |
|---|---|
| **Dashboard** | Chakra (and chakra held by bids), free packs and next refill, Mythic guarantee, golden pack, collection by rarity, missions, latest cards, auctions ending soon, automation activity |
| **Missions** | Daily, weekly, streak and achievement progress; claim rewards |
| **Characters** | The whole catalogue: search by name, native name or ID; filters by rarity, series, power, aura, owned/missing; detail with drop chance per pack and market prices |
| **My collection** | Cards owned, completion by rarity, series closest to completion, duplicates |
| **Market** | Listings with filters and countdowns, recent sales, **bid** and **buy**, your market activity |
| **Trades** | Trades sent (by hand or by a monitor) and received; cancel a pending one |
| **Packs** | Each pack's current cost to you and odds, **open ×1/×5/×10**, the reveal, opening history |
| **Monitors** | Market, chat-trade and account monitors with status and run history: auto-bid with a copies target, trade answers (preview or send), auto-claim, free-pack opening, a kill switch |
| **Session & bridge** | Session status (never the credentials), the desktop Kyara window, paired browsers, server and API health |
| **Settings** | Spending limits: per action, automatic bidding, sending trades. Raising one asks first. Start with Windows |
| **Activity** | Every action and its outcome, live events, redacted server logs |

Anything that spends chakra shows the summary and cost from the server's own checks and
asks before sending one request. If Kyara does not confirm in time, the action is marked
**unknown** and never retried automatically; resolve it in **Activity** after checking the
account.

## Command line

Run commands with `npm run dev -- <command>`, `node dist/cli/bin.js <command>` after a
build, or `kyara <command>` after `npm link`.

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
| `monitor` | `auctions`, `account`, `collection` (terminal versions of the monitors) | varies |
| `actions` | `list`, `show <id>`, `resolve <id> --as succeeded\|failed` | – |
| `api` | `verify [--shapes]` (GET only), `get <path>` | optional |

**Bold** commands change account state and accept `--dry-run`, `--yes` and `--force-budget`.
Exit codes: `0` ok, `1` failure, `2` usage, `3` login, `4` rate limited, `5` outcome unknown,
`6` refused by a safeguard, `7` network.

## Configuration

Spending limits are normally set in the app under **Settings** (stored in `settings.json`).
A spending variable set in `.env` overrides the app and shows as locked there.

| Variable | Default | Meaning |
|---|---|---|
| `KYARA_BASE_URL` | `https://kyara.games` | Site URL |
| `KYARA_DATA_DIR` | `.kyara` | Session, settings, monitors, pairing, journal, cache. Keep it private |
| `KYARA_TOKEN` | – | Token override, never written to disk |
| `KYARA_TIMEOUT_MS` | `15000` | Per-request timeout |
| `KYARA_MAX_RETRIES` | `3` | Retries for read requests only |
| `KYARA_MIN_INTERVAL_MS` | `250` | Minimum spacing between requests to Kyara |
| `KYARA_HEADLESS` | `false` | Bot browser mode (CLI login only) |
| `KYARA_LOG_LEVEL` / `KYARA_LOG_FORMAT` | `info` / `pretty` | |
| `KYARA_MAX_SPEND_PER_ACTION` | `500` | Refuse actions that may spend more chakra |
| `KYARA_AUTO_BID_ENABLED` / `_BUDGET` / `_MAX` | `false` / `0` / `0` | Allow automatic bidding, its budget per monitor and maximum per copy |
| `KYARA_AUTO_TRADE_ENABLED` / `_BUDGET` | `false` / `0` | Allow trade monitors to send; chakra allowed in pending trades (0 = cards only) |

The installed desktop app reads `.env` from its data folder (`desktop:dev` uses the
repository's), and also honours `KYARA_PORT` from the environment.

## Packs and Kyara's anti-bot pass

When Kyara enables Cloudflare Turnstile, opening packs needs a pass that the site renews
only while its page is open and visible. The bot then opens packs only while the app's Kyara
window or a kyara.games tab (with the extension) is on screen, and free packs accumulate up
to their cap in the meantime. While Turnstile is off (`/api/auth/providers` returns
`"turnstile": null`, as in October 2026), the site uses no pass and packs open in the
background like everything else. Claims, bids and trades never wait for the pass. More in
[docs/automation.md](docs/automation.md).

## Development

```bash
npm run serve -- --dev-origin http://localhost:5173   # API and bridge for the dev server
npm run web:dev                                       # Vite on :5173, proxies /app-api
npm run ext:build                                     # then reload the extension in the browser
npm run desktop:dev                                   # build and start the desktop app

npm run typecheck   # server, web app, extension, desktop app
npm run lint
npm test            # unit, server, bridge security, React components (no network)
npm run test:e2e    # Chromium: extension end to end, web app smoke test, read-only site check
```

The tests never send a purchase, bid, opening, claim or trade to the real site. The e2e
tests mock Kyara or block every write when they load the real page.

## Troubleshooting

- **"Bot offline" in the app**: the server is not running, or runs on another port.
- **"Another Kyara bot is already running"** (desktop app): `npm run serve` is running in a terminal. Stop it; the app is the server.
- **Packs are not opened** while Kyara requires its pass: open the Kyara window (or a kyara.games tab) and keep it in view for a few seconds.
- **"Kyara wants its anti-bot pass"** on bids or trades: same fix; the monitor retries on its next check.
- **Trade monitor only previews**: allow **Sending trades automatically** in Settings and set the monitor to *Send trades*.
- **Popup: "Not reachable on port 47321"**: start the server; for another port, set it under *Advanced* and pair again.
- **Popup: "Pairing revoked"**: the pairing was removed in the app or CLI. Create a new code and pair again.
- **Popup: "Different account than this tab"**: the bot holds a session for another account. Forget it on the Session page (or `session logout`), or log in to the right account on kyara.games.
- **An action shows "unknown"**: Kyara did not confirm in time. Check the account on kyara.games, then mark it in **Activity**. Pack openings can be re-sent safely with `packs open <id> --resume <action id>`.
- **"Rate limited"**: wait a minute. Do not lower `KYARA_MIN_INTERVAL_MS`.
- **"Unexpected response shape"**: Kyara changed its API. Run `npm run dev -- api verify --shapes` and update `src/api/schemas/`.

## Security and limits

- The server binds to 127.0.0.1 and checks Host, Origin and a per-run app token; the bridge
  uses one-time pairing and signed requests. Details and the trust boundary:
  [docs/bridge-security.md](docs/bridge-security.md).
- Software already running under your OS account can read the data directory and your
  browser profile; nothing here protects against that.
- Tokens, passes, pairing secrets and authorization headers are redacted from logs, events
  and errors. `.env`, `.kyara/` and build outputs are git-ignored.
- The bot never accepts or declines a trade, never writes in the chat, and only offers spare
  copies in trades Kyara's fair-play check calls fair. Selling, buy orders, recycling and
  social features are not implemented.
- The desktop Kyara window is a plain browser window: no visibility tricks, no user-agent
  changes, nothing injected into the page. The app reads three localStorage values from an
  isolated script context, as the extension does.

## Documentation

- [docs/architecture.md](docs/architecture.md): components, request pipeline, action guard, session, monitors
- [docs/automation.md](docs/automation.md): safeguards, monitors, auto-bid and chat-trade rules, what is verified live
- [docs/bridge-security.md](docs/bridge-security.md): extension, pairing, signatures, desktop window, trust boundary
- [docs/api-reference.md](docs/api-reference.md): Kyara endpoints with their verification status
