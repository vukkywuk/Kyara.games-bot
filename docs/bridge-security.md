# Browser bridge: design and security

The **Kyara Bridge** extension keeps the local bot in sync with the Kyara session of
your normal browser. You log in to kyara.games and pass Cloudflare's checks yourself, in
your own browser. The extension only reads what the site already stored and hands it to
the bot on your machine.

## What the extension does and does not do

| Does | Does not |
|---|---|
| Runs a content script on `https://kyara.games/*` only | Run on any other site (no `<all_urls>`, no `tabs` permission) |
| Reads exactly three localStorage keys the site maintains: `kyara_token`, `kyara_device`, `kyara_pass` | Read cookies, other storage keys, page content, history |
| Sends them to `http://127.0.0.1:<port>/bridge/*` | Talk to any other server |
| Sends the token only when the bot asks for it (its fingerprint differs from the bot's) | Resend unchanged material (fingerprints are compared first) |
| Stores its pairing (client id + secret) in `chrome.storage.local` | Persist the token or the pass anywhere (only fingerprints, in memory-only `chrome.storage.session`) |
| | Interact with the page, Turnstile, Cloudflare or any challenge |
| | Log any value (no `console` output of session material) |

Permissions: `storage`, plus host access to `https://kyara.games/*` and `http://127.0.0.1/*`.

Why the pairing secret is persisted: without it, every browser restart would require
pairing again. It is a random 256-bit value that only authenticates this extension to
your local bot; it is not a Kyara credential and is useless to Kyara.

## Pairing

1. In the app (Session & bridge), **Create pairing code**. The server generates an
   8-character code (40 bits from an unambiguous alphabet), valid for 5 minutes, single use,
   invalidated after 5 wrong attempts. Pairing attempts are rate-limited (10 per 5 min).
2. You type the code in the extension popup. The code travels in a POST body, never in a URL.
3. The server checks that the request `Origin` is a browser-extension origin, compares the
   code in constant time, and returns a per-client secret **once**.
4. Revoke a browser from the app, from the popup (Unpair), or with `kyara bridge unpair <id>`.

## Request authentication

Every bridge request after pairing is signed:

```
x-kyara-client: <client id>
x-kyara-ts:     <unix ms>          rejected if more than 60 s off
x-kyara-nonce:  <128-bit random>   rejected if seen before (replay cache)
x-kyara-sig:    hex(HMAC-SHA256(secret, METHOD \n PATH \n ts \n nonce \n sha256(body)))
```

The signature binds the method, the path and the body, so a captured request cannot be
replayed or redirected to another operation. Signatures are compared in constant time.
If the request carries an `Origin`, it must be the one recorded at pairing (defence in
depth; the signature is what authenticates). Failed authentication is rate-limited.

The bridge accepts exactly four operations: `pair`, `status`, `sync`, `unpair`. It is not
a proxy to Kyara or to the filesystem. It never returns the token, the pass or the secret
after pairing. Bodies are limited to 8 KB and validated with a strict schema (unknown
fields are rejected).

## Session handling on the bot side

One session manager (`src/auth/SessionManager.ts`) owns the session. Bridge syncs, CLI
imports and logout go through the same mutex, so concurrent updates cannot interleave.

- A token from the browser is stored **only after Kyara accepts it** (`GET /api/me`). A
  token Kyara refuses is remembered by fingerprint and never requested again (no resend loop).
- A pass is accepted only if it belongs to the session the bot uses (same token
  fingerprint) and has more than a minute left.
- Logging out in the browser clears the pass, and a bridge-provided token. A token you
  imported by hand is left alone (it may be a different session).
- Everything is persisted in `session.json` in the data directory (mode 0600; `.kyara/` by
  default, git-ignored) and every secret is registered with the log redactor.

## The local server

`kyara serve` listens on **127.0.0.1 only** and also drops any non-loopback connection.

| Surface | Protection |
|---|---|
| All routes | Host header must be `127.0.0.1:<port>` or `localhost:<port>` (DNS rebinding); no CORS headers; `OPTIONS` refused; `nosniff`, `DENY` framing, no referrer |
| `/bridge/*` | Pairing code / HMAC signatures as above, body ≤ 8 KB, rate limits |
| `/app-api/*` | Per-run app token, handed only to same-origin pages (`Sec-Fetch-Site`), required in a custom header (forces a preflight that is refused for other origins); `Origin` must be the app's for any write; body ≤ 16 KB; zod validation |
| `/` (web app) | Strict CSP: scripts, styles, fonts and connections from self only; images from self and the AniList CDN |

State-changing app calls are two-step (`dryRun`, then `confirm`) and always go through
the same `ActionGuard` as the CLI: budget, duplicate protection, cross-process lock,
journal, no blind retry on an unknown outcome.

## Desktop app: the built-in Kyara window

The desktop app can replace the extension. Its *Kyara* window is an ordinary Chromium window
on https://kyara.games with its own persistent storage (`persist:kyara` partition). You log
in there yourself.

- While that window is open, the main process reads `kyara_token`, `kyara_device` and
  `kyara_pass` every 15 s, and on load and focus. It reads them through
  `executeJavaScriptInIsolatedWorld`, so the page's own scripts cannot tamper with the reader.
  Only when the window's origin is exactly `https://kyara.games`.
- The values go through the same entry point as the extension
  (`SessionManager.applySiteSnapshot` -> `applyBridgeSync`): `/api/me` validation, refusal to
  switch accounts silently, rejected-token memory. The session source is `app`.
- A logged-out Kyara window only clears a session that came from that window, never one from
  the extension or an import.
- No visibility override, no throttling tricks, no user-agent change, nothing injected into
  the page's world. While Turnstile is enabled, the site renews its pass only while the window
  is visible, as in any browser.
- The app window shows only the local app (`http://127.0.0.1:<port>`): navigation elsewhere
  is blocked and external links open in your default browser. Its preload exposes four calls
  (open the Kyara window, read or set start with Windows, open the data folder), each checked
  against the sender in the main process. Both windows run sandboxed with context isolation
  and no Node integration.

## In-app spending settings

Spending limits can be changed from the app (`PUT /app-api/settings`, behind the same
loopback, Host, Origin and app-token checks). Any change that lets the bot spend more is
refused with `409 confirm_required` unless the request carries an explicit confirmation, which
the UI only sends after its confirmation dialog. A value set in `.env` always wins and cannot
be changed from the app.

## Trust boundary (what this does not protect against)

The bridge protects your session from **web pages and other machines**. It does not, and
cannot, protect against software that already runs under your operating-system account:

- such software can read the data directory's `session.json`, the extension's storage, or
  your browser's own profile, and it can inspect process memory;
- a malicious browser extension with access to kyara.games could read the same
  localStorage keys the site itself keeps there.

Keep your machine and browser extensions trustworthy. To cut access quickly: Unpair in
the popup (or revoke in the app), then `kyara session logout`, which revokes the token on
Kyara's side.

## What is verified

- Automated tests (`tests/bridge.test.ts`): pairing (origin, wrong code, single use,
  attempt limit, rate limit), signatures (missing, forged, replayed, stale, wrong origin,
  path-bound), sync (token validation, rejected tokens, foreign or expired passes,
  logout), malformed and oversized payloads, serialised concurrent syncs, per-client rate
  limit, no secrets in logs or events, unpairing, Host/Origin/app-token checks, shutdown.
- End to end in Chromium (`tests/extension.e2e.test.ts`): the built extension pairs from
  its popup, syncs a stubbed kyara.games tab's session to a real bridge server, never
  shows or stores the token or pass, and unpairs.
- Not automated: a sync from the real kyara.games site, which needs a logged-in browser.
  It has been checked by hand, through the extension (Brave) and through the desktop app's
  Kyara window.
