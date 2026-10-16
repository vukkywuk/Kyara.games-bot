# Automation: workflows, safeguards, limits

## Principles

- Only features available to **your own account** through the site's normal flows.
- **No bypassing** of Cloudflare Turnstile, CAPTCHAs, logins or limits. When the site wants a human, a visible browser window opens and the bot waits for you.
- Conservative request rates: serialised requests, ≥ 250 ms apart by default, honouring the server's `x-ratelimit-*` and `retry-after` headers.
- Notifications by default. Anything that spends automatically (chakra or cards) must be explicitly enabled in **two** places (Settings, or `.env`, and the monitor itself) and is capped.

## Supported workflows

| Workflow | Command | Spends? | Confirmation | Status |
|---|---|---|---|---|
| Log in (Discord, in a visible browser) | `session login` | – | you log in yourself | Implemented; needs your first run to confirm end to end |
| Import a token you copied | `session import` (stdin) | – | – | Implemented, tested with mocks |
| Open packs | `packs open <id> [-c N]` | chakra if no free/bonus/grant left | **yes** when chakra is spent | Implemented, tested with mocks; the live flow is INFERRED |
| Bid on an auction | `market bid <listing> <max>` | reserves `max` | **always** | Implemented, tested with mocks; INFERRED |
| Buy a listing | `market buy <listing> [--max-price]` | yes | **always** | Implemented, tested with mocks; INFERRED |
| Claim rewards | `progress claim [kind] [id]` | no | no | Implemented, tested with mocks; INFERRED |
| Watch auctions | `monitor auctions …` | no (unless `--auto-bid`) | – | Implemented |
| Watch the account | `monitor account …` | no | – | Implemented |
| Watch the collection | `monitor collection` | no | – | Implemented |
| Answer chat trade requests | app → Monitors → *Chat trades* | spare cards, chakra if allowed | preview first; sending needs Settings | Implemented, tested with mocks; reads CONFIRMED, proposal INFERRED |

"INFERRED" means the request format comes from the site's own code, but it has not
been sent live yet (no session was available while building, and no costly action was
sent on purpose). See "First live run" below.

## Pack pass (Cloudflare Turnstile)

Opening packs needs a pass (about 30 min) that the server only issues after a Turnstile check. Observed on 2026-10-10: Cloudflare **refuses the bot's Playwright browser** (error 600010) even before any click, because it is visibly automated. The bot does not try to hide that. Instead:

1. Keep https://kyara.games open, logged in, in your normal browser. While the tab is visible, the site renews its own pass every minute, and Cloudflare passes a normal browser silently.
2. Copy `kyara_pass` from DevTools → Application → Local Storage, and run `session import-pass` (add `--device-id <kyara_device>` the first time).
3. Open packs with the bot until the pass expires (`session status` shows the time left).

If the server rejects an imported pass (`pass_required`), nothing is opened and the bot asks for a fresh one. Unattended free-pack opening (`monitor account --auto-open-free`) therefore only works while an imported pass is valid.

In the desktop app, the built-in Kyara window does the same automatically: while it is open
and visible, the site renews its pass and the app syncs it, so free packs are opened.

**Bids, buys and trade proposals** are sent the way the site sends them: with the stored pass
attached when one is valid. Kyara does not always require it. If it answers `pass_required`,
nothing was applied: the action is reported as "Kyara wants its anti-bot pass" and the
monitor tries again on its next check, once a pass is synced.

## Safeguards on every state-changing action

1. **Input validation**: ids must be UUIDs / positive integers; counts 1–10; amounts positive integers.
2. **Fresh preflight**: before sending, the bot re-reads the server state. It checks the balance (`insufficient_funds`), pack availability, schedule, daily limit and grant-only status; and for listings: active, not yours, an auction for bids, above `minNextBid`, below the buyout.
3. **Cost shown first**, e.g. `Open 2× "Hall of Fame" (2 paid) — cost 1500 chakra (balance 3200)`.
4. **Explicit confirmation** for anything that spends (type `yes`). In a non-interactive shell, it refuses unless `--yes` is passed.
5. **Per-action spending cap**: Settings → *Most chakra one action may spend* (or `KYARA_MAX_SPEND_PER_ACTION`, default 500); `--force-budget` overrides it once.
6. **Server-side ceiling**: pack openings send `maxChakra` = the quoted cost, so the server refuses (`cost_changed`) instead of charging more.
7. **Duplicate protection**: an in-process "already running" check, a cross-process lock file, and a per-action cooldown (bids: same listing + amount within 60 s; buys: same listing within 24 h; openings: 2 s).
8. **Uncertain outcomes are never retried.** A timeout or 5xx on a write is recorded as `unknown` and blocks identical actions until resolved:
   ```
   kyara actions list --status unknown
   kyara account me              # check what actually happened
   kyara actions resolve <id> --as succeeded   # or failed
   kyara packs open all --resume <id>          # openings only: re-sends the same idempotency key
   ```
9. **Journal**: every action is appended to `.kyara/actions.jsonl` (secrets redacted).
10. **`--dry-run`** runs all checks and shows the summary without sending anything.

## Auto-bidding (off by default)

Requires **Automatic bidding** in Settings (with a budget and a maximum per copy), or in `.env`:

```
# .env (overrides Settings)
KYARA_AUTO_BID_ENABLED=true
KYARA_AUTO_BID_BUDGET=2000   # most chakra one monitor may have committed (held bids + copies won)
KYARA_AUTO_BID_MAX=400       # ceiling per copy
```

```
kyara monitor auctions --character 127691 --max-price 300 --auto-bid --copies 2 --within 2m
```

In the web app, the same settings are under Monitors, then a market monitor, then
Automatic bidding: copies to get, total budget (empty = copies × maximum price) and the
bidding window.

Kyara bids are proxy bids: you set a maximum, and the server raises your bid only as far
as someone else pushes it. So the monitor:

- sends your maximum (`min(max price, KYARA_AUTO_BID_MAX)`, kept under any buyout) **once**
  per auction, in its last `--within`, skipping auctions already above it;
- stops once *won + currently leading* reaches `--copies`, and bids on the next auction
  when it is outbid or loses;
- never commits more than the budget, counting bids still leading at their maximum and
  copies won at their final price (outbid bids are refunded, so they stop counting);
- wakes up right when the next auction enters the window, and right after a leading
  auction ends to record a win or a loss;
- in the server, keeps copies won and bids in flight in `.kyara/monitors.json`, so a
  restart does not start over. Editing what the monitor watches resets the count.

Each bid goes through the same guarded path as a manual bid (fresh preflight, journal,
per-action cap). An unknown outcome stops auto-bidding until the monitor is saved again.

## Account automation (opt-in, never spends)

```
kyara monitor account --auto-claim                 # claims rewards when available
kyara monitor account --auto-open-free all         # opens "all" only while it costs 0 chakra
```

`--auto-open-free` opens every free pack available in one request (up to 10), re-quotes
before each opening and refuses if the cost is not 0 (`requireFree`). It checks again a few
seconds after the next free pack regenerates, rather than waiting a full interval.

It needs a valid pack pass, which the site renews only while a kyara.games tab is visible.
When the pass is missing or rejected, the monitor skips the opening and posts one
"Free packs not opened" event with the reason, instead of failing silently.

## Chat trades (preview by default)

Players post structured requests in the market chat: a card tagged **“Anyone have it?”**
(`seek`: they want it) or **“Available for a trade”** (`trade`: they offer it). A *Chat trades*
monitor reads every chat room (read only, it never posts) and answers new requests, at most a
few minutes old, with a trade proposal:

- **They look for a card I have spare** → give one spare copy, and ask for the most valuable
  card **on my wishlist** that they can trade, worth 80–130 % of mine (configurable). If none
  fits, ask for chakra at 110 % of its value (configurable, or off).
- **They offer a card on my wishlist** → pay with my spare copies (cards they do not own
  first, up to 3 cards worth 80–110 % of it), else with chakra up to a cap.

Values are Kyara's own fair-play reference prices (`/fair-play/prices`), and every proposal
goes through a port of the site's fair-play check: only trades it calls **fair** are sent
(never a “gift”, never over the limits with that player).

What counts as spare: `qty − locked − resaleLocked − 1`, the site's own rule, minus extra
copies you choose to keep. Cards in a pending trade are locked by Kyara, so they are never
offered twice, sold or listed meanwhile. Within one check the monitor also reserves them
itself.

Limits, all per monitor: proposals pending at once (default 3), per hour (5), one per player
per 24 h, a chakra budget for pending trades (0 = cards only, capped by Settings), requests at
most 10 minutes old. The bot **cancels its own unanswered proposals after 30 minutes**
(configurable) so the cards are free again, because Kyara would keep them locked for 48 h.

Modes: **Preview** (default) posts “Would offer…” events and sends nothing. **Send trades**
only takes effect when *Sending trades automatically* is on in Settings
(`KYARA_AUTO_TRADE_ENABLED`). The bot never accepts or declines a trade for you; received
trades are answered on kyara.games. An unclear outcome stops the monitor until you save it again.

## Limits and caveats

- Session **read** endpoints are confirmed against a real account (trades, chat and fair-play included). The **write** responses (open, claim, bid, buy, trade proposal, cancel) are still inferred; if one differs, you get a `SchemaMismatchError` and the action is recorded as `unknown` (the server may have applied it). Check the account before retrying.
- Bids and purchases also check `/me/market/access` first and refuse with the server's reasons while the market is locked for the account.
- An ambiguous error on a bid or a purchase cannot be resumed automatically (these endpoints have no idempotency key). Check the account by hand.
- The market has no server-side price filter; `--max-price` filters the fetched pages locally.
- Real-time events (`/api/me/events`, SSE) are not used; monitors poll at conservative intervals instead.
- Selling, cancelling listings, buy orders, accepting/declining trades, recycling, friends/DMs and posting in the chat are discovered but **not automated** (destructive or social actions). See `docs/api-reference.md`.

## First live run (recommended)

```
npm run browser:install
npm run dev -- session login        # log in with Discord in the window
npm run dev -- api verify --shapes  # confirms the inferred read schemas (GET only)
npm run dev -- progress claim --dry-run
npm run dev -- packs quote all
npm run dev -- packs open daily --dry-run
```

Then try one free opening (`packs open all` while you have free packs). It costs
nothing and confirms the pass + opening flow end to end.
