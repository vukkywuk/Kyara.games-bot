# Implementation checklist

Starting point: the repository contained only `LICENSE` (one "Initial commit"). Nothing to preserve.

## Reconnaissance
- [x] Repository and toolchain inspected (Node 22.21, npm 10.9)
- [x] Site JS bundle crawled (71 chunks); API client module located and mapped
- [x] Public endpoints probed live (read-only, paced); rate-limit headers recorded
- [x] Auth model identified: bearer token in localStorage, Discord OAuth, Turnstile-gated guest creation and pack pass
- [x] DevTools route names mapped to real paths (short names return 404)
- [x] `docs/api-reference.md` with CONFIRMED / INFERRED / DISCOVERED levels

## Foundation
- [x] Strict TypeScript, ESLint, Vitest, npm scripts (dev/build/start/typecheck/lint/test)
- [x] Config from `.env` validated with zod; `.env.example` with placeholders; `.gitignore` for secrets
- [x] Logger with secret redaction (by key, pattern, and registered values)
- [x] Typed error hierarchy with CLI exit codes
- [x] Single HTTP client: auth headers, serialised + spaced requests, rate-limit awareness, GET-only retries, zod validation
- [x] Transport abstraction: direct fetch / in-page browser fetch

## Auth & browser
- [x] Session store (atomic, 0600, git-ignored), env override, invalidation on 401
- [x] Browser login flow (visible window, waits for a human, validates the token against /me)
- [x] Token import from stdin; status; logout with server revocation; browser profile wipe
- [x] Turnstile verifier (official widget, human completes it if asked) → pack pass manager
- [x] Diagnostics capture (screenshot, URL, redacted console; no storage)
- [x] Live headless browser tests (read-only, side effects blocked)

## Features
- [x] Characters: catalogue cache, search, filters, sorting, detail, series summary
- [x] Packs: list with availability, rates, pools, exact cost quote
- [x] Market: listings, detail, prices, order book, trade offers, bounded pagination
- [x] Account: me, wallet summary, wishlist
- [x] Collection: list, stats, missing, snapshots, diff
- [x] Progress: view, claimables
- [x] Guarded writes: pack opening (pass, idempotency key, maxChakra, resume), bid, buy, claim
- [x] Action journal, duplicate protection, cross-process lock, ambiguous-outcome handling
- [x] Monitors: auctions (+ opt-in capped auto-bid), account (+ opt-in auto-claim / free-only auto-open), collection

## Quality
- [x] Unit tests: schemas (live fixtures), HTTP client, search, pricing, guard, packs, market, progress, monitors, session, redaction
- [x] Typecheck, lint, build, tests passing

## Needs a logged-in session (cannot be done without your account)
- [x] First session (via `session import`; the browser-login navigation bug found on the first try is fixed)
- [x] `kyara api verify --shapes`: all 8 session read endpoints confirmed; schemas extended (chakraHeld, nextFreeAt, pity, market access…)
- [x] Free pack openings end to end (many, from the app and the account monitor, 2026-10-10/11)
- [ ] One claim when something is claimable

## v0.2: bridge, extension, web app
- [x] Loopback server (`kyara serve`): bridge, app API, static app, SSE; Host/Origin/app-token checks, CSP, no CORS
- [x] Extension (MV3): minimal permissions, one-time pairing, HMAC-signed sync, fingerprint dedup, popup
- [x] One session manager: serialised bridge sync / import / logout, change events, cross-process reload
- [x] Web app: dashboard, missions, characters (virtualised, URL filters), collection, market (bid/buy), packs (open + reveal), monitors, session & bridge, activity
- [x] Design system tokens, motion system, reduced motion, phone layouts
- [x] Security, correctness and conventions reviews (feature-dev code-reviewer agents); findings fixed with regression tests
- [x] Tests: bridge security, extension unit + Chromium end to end, React components, web smoke test (Kyara mocked)
- [x] Real sync from kyara.games through the extension (Brave)
- [ ] First real pack opening / bid from the app (needs your decision to spend)

## v0.3: trades, settings, desktop app
- [x] Trade API: chat (read only), my trades, tradeable/owned cards, fair-play limits and prices (all reads CONFIRMED live)
- [x] Fair-play verdict ported from the site; trade planner (wishlist card, else chakra; spare cards, else chakra)
- [x] Chat-trade monitor: preview / send, pending, hourly, per-player and budget limits, stale proposals cancelled, outcomes followed and persisted
- [x] Trades page (sent / received, cancel); trade monitor editor
- [x] Stored pass attached to bids, buys and proposals like the site; `pass_required` reported, not retried
- [x] In-app spending settings (`.env` wins, raises need confirmation, live in guard and monitors)
- [x] Desktop app (Electron): tray, close to tray, start with Windows, notifications, Kyara window session sync, setup wizard, NSIS installer
- [ ] First real trade proposal (preview first, then one card-for-card trade with `maxPending 1`)
- [ ] First login through the desktop app's Kyara window (Cloudflare's view of the embedded window is not known yet; the extension stays the fallback)

## Possible next steps
- [ ] SSE (`/api/me/events`) instead of polling for notifications
- [ ] Selling / cancelling listings and buy orders (with the same guard)
- [ ] Notification sinks (Discord webhook)
