# Kyara API reference (reverse-engineered)

Kyara has **no documented or officially supported public API**. Everything below was
reconstructed on 2026-10-10 from:

1. the site's public JavaScript bundle (SvelteKit), in particular its API client module,
   which lists every route the frontend calls together with the HTTP method and body;
2. live, **read-only, unauthenticated** requests to the public endpoints;
3. how the frontend reads each response (for endpoints that need a session).

The site can change any of this without notice. Run `kyara api verify` to re-check the
schemas against the live site (it only sends GET requests).

## Verification levels

| Level | Meaning |
|---|---|
| **CONFIRMED** | Called live; the response was validated by the bot's Zod schema (`kyara api verify`). |
| **CONFIRMED (errors)** | Error behaviour observed live (status code + `error` code). |
| **CONFIRMED (session)** | Called live with a logged-in account, and the response validated against the schema. Reads were checked with `kyara api verify --shapes` on 2026-10-10; pack openings, claims and bids were confirmed by real use. |
| **INFERRED** | Method, path and body come from the site's own client code; the response shape comes from the fields its UI reads. Not sent live yet: buying, pass creation, trade proposals and cancellation, wishlist writes. |
| **DISCOVERED** | Present in the client code but not implemented by the bot. |

## Conventions (CONFIRMED)

- Base: `https://kyara.games/api`. The page is served by SvelteKit. Responses come from several API nodes (`x-kyara-node: api-1…api-8`).
- **No Cloudflare challenge on plain HTTP requests** to the API (observed). Cloudflare **Turnstile** is used only for specific actions (guest creation, pack pass), and only while `/auth/providers` returns a site key. In October 2026 it returned `null`.
- **Errors** are JSON `{ "error": "<code>", "message": "<text, usually French>" }` with a matching HTTP status. Examples observed: `401 unauthorized`, `400 bad_request` (validation message), `404 not_found`.
- **Rate limiting**: every response carries `x-ratelimit-limit: 2000`, `x-ratelimit-remaining` and `x-ratelimit-reset` (seconds to window reset; the window looked like 60 s). The bot honours these and `retry-after`. It also keeps requests serialised and spaced (`KYARA_MIN_INTERVAL_MS`, default 250 ms).
- **`date` header**: the site uses it to correct clock skew. The bot does the same (`ServerClock`).
- **Device id**: the frontend sends `x-device-id: <uuid>` on every request (stored in `localStorage.kyara_device`). The bot does the same, reusing the browser's value after login.
- **Transient 503**: with `error` = `catalog_loading` or `starting`, the frontend retries GETs every 1.5 s, up to 8 times. The bot retries them too.

## Authentication (INFERRED from the client, partly CONFIRMED)

- The session is a **bearer token**: `authorization: Bearer <token>`. The frontend keeps it in `localStorage.kyara_token` and sends it explicitly; it is **not** a cookie. So an independent HTTP client can use the same token (the request path is identical to the site's own `fetch`). Without it, `/api/me` returns `401 {"error":"unauthorized","message":"Connexion requise"}` (CONFIRMED).
- **Guest accounts**: on first use, the frontend calls `POST /api/auth/guest` with a Turnstile token and stores the returned `{ token }`. Guests are limited (`403 guest_limit`; `config.guestBoosterLimit`).
- **Discord login**: the browser navigates to `/api/auth/discord?token=<current guest token>[&ref=<code>]`. After OAuth, the callback page reads `#token=…` from the URL fragment and stores it in `localStorage.kyara_token`.
- **Logout**: `POST /api/auth/logout` with the bearer token, then the frontend deletes the token.
- **Pack pass ("laissez-passer")**: while Turnstile is enabled, opening packs requires an `x-pass` header. It is obtained with `POST /api/auth/pass {"turnstile": "<token>"}` -> `{ pass, expiresAt }` (≈30 min; the frontend renews it when < 5 min remain, and every minute while the tab is visible). If the server answers `pass_required`, the frontend renews the pass and re-sends the **same** request. When `/auth/providers` has no Turnstile key, the frontend requests no pass and sends no `x-pass` header; the bot does the same.

## Endpoint inventory

Legend: **R** = read-only, **W** = changes server state. "Auth": none / optional (adds per-user fields) / required.

### Site & catalogue (public)

| Method & path | Purpose | Params | Auth | R/W | Status |
|---|---|---|---|---|---|
| `GET /health` | Liveness + catalogue state `{ ok, catalog: { ready, size, target, ranked, featured, fetching, lastError } }` | – | none | R | CONFIRMED |
| `GET /edge` | `{ nodes }`. Used by the frontend to tell "maintenance" from "busy" | – | none | R | CONFIRMED (not used by the bot) |
| `GET /config` | Game rules: `catalogSize`, `freePacks { max, regenHours, boosts[] }`, `recycle` (chakra per rarity), `dropWeights`, `pity`, `golden`, `godPackChance`, `guestBoosterLimit`, `resets`, `referral` | – | none | R | CONFIRMED |
| `GET /auth/providers` | `{ discord: bool, turnstile: "<site key>" \| null }` (`null` while Turnstile is off) | – | none | R | CONFIRMED |
| `GET /notice` | `{ text: string \| null }` site banner | – | none | R | CONFIRMED |
| `GET /characters` | Full catalogue, about 6,736 items (about 1.7 MB): `{ id, name, native, image, favourites, num, pow, rank, rarity, series, aura }` | – | none | R | CONFIRMED |
| `GET /characters/:id` | Character + `dropChance` (per pack id, %) + `prices` (market stats) | `id` int | none | R | CONFIRMED |
| `GET /characters/heritage` | Characters removed from rotation ("heritage"), with `heritage: true` | – | none | R | CONFIRMED |
| `GET /characters/news` | Latest catalogue update `{ id, at, before, after, removed, addedCount, series[], samples[] }` | – | none | R | CONFIRMED |
| `GET /characters/news/mine` | Same, personalised | – | required | R | DISCOVERED |
| `GET /characters/:id/detail` | Extended detail (wiki card) | – | required | R | DISCOVERED |
| `GET /changelog` | Release notes `[{ id, title, items[{kind,text}], publishedAt }]` | – | none | R | CONFIRMED |
| `GET /launch` | Launch event and referral leaderboard | – | none | R | CONFIRMED (not wrapped) |
| `GET /push` | Web-push VAPID key and topics | – | none | R | CONFIRMED (not used) |
| `GET /membership` | Membership offer (`available:false, staffOnly:true` at time of writing) | – | none | R | CONFIRMED (not used) |

### Packs (boosters)

| Method & path | Purpose | Params / body | Auth | R/W | Status |
|---|---|---|---|---|---|
| `GET /packs` | All packs: `id, name, price, chakraPrice, usesFreePacks, slots[], limit{perDay}, schedule{start,end}, grantOnly, featuredPity, goldenEligible, rates{poolSize, cardsByRarity, slots[], perBooster, pity}, showcase[]` | – | none | R | CONFIRMED (note: `rates.pity.rarity` can be `null`) |
| `GET /packs/:id/characters` | Ids of all characters that can drop from a pack | `id` pack id | none | R | CONFIRMED (`404 not_found "Booster inconnu"` for unknown ids) |
| `GET /rates` | Rarity rates `[{ rarity, label, pct, boosterPct, expectedPerBooster, perCardBoosterPct }]` | `?pack=<id>` optional | none | R | CONFIRMED (404 for unknown pack) |
| `GET /me/packs` | Per-pack daily limits `{ limits: { <packId>: { left } }, day, featuredPity: { <packId>: … } }`. May include packs absent from `GET /packs` (e.g. hidden event packs) | – | required | R | CONFIRMED (session) |
| `POST /packs/:id/open` | Open one pack | headers `x-request-id` (idempotency key, 32 hex), `x-pass` while Turnstile is on; body `{ maxChakra? }` | required | **W** | CONFIRMED (session) |
| `POST /packs/:id/open-many` | Open N packs | same headers; body `{ count, maxChakra? }` | required | **W** | CONFIRMED (session) |
| `GET /packs/pulls/:shareId` | Public view of a shared pull | – | none | R | DISCOVERED |

Open result (CONFIRMED (session)): `{ user: <Me>, cards: [<Character> & { isNew?, wished?, featured? }], godPack?, golden? }`.
Open-many: `{ results: [<open result>], stopped?: { code, message } }`. `stopped` means a partial run, for example `guest_limit`.

**Cost rules** (ported verbatim into `src/modules/packPricing.ts`): grants first, then free packs, then bonus packs (only for packs with `usesFreePacks`), then `chakraPrice` (fallback `price || 150`). Packs with `grantOnly` need a grant. Packs with a `schedule` can only be opened inside the window. Packs with a `limit` respect `GET /me/packs`.
The frontend sends `maxChakra` = the cost it displayed. The server answers `cost_changed` if the real cost differs, so `maxChakra` acts as a spend ceiling.

Known pack errors: `chakra` / 402 (insufficient), `daily_limit`, `pack_unavailable`, `grant_required`, `cost_changed`, `pass_required`, `guest_limit`.

**Idempotency**: the frontend generates one `x-request-id` per click. On transient failures it re-sends with the same id for up to 2 minutes. This strongly suggests server-side deduplication by that id (INFERRED; not verified with a live duplicate, on purpose).

### Account & progression

| Method & path | Purpose | Params / body | Auth | R/W | Status |
|---|---|---|---|---|---|
| `GET /me` | Current user: `id, pseudo, chakra` (spendable), `chakraHeld` (reserved by bids/buy orders, **not** included in `chakra`), `freePacks, freePacksMax, nextFreeAt, freeBoost{id,label,end,max,regenHours,baseMax,baseRegenHours}, bonusPacks, grants{packId:n}, goldenIn, pity` (openings toward the Mythic guarantee), `boostersOpened, discord{id,username,avatar}, trust{enforced,mfa,ranking,referral,market,limited,altSide,tips}, ban, membership, createdAt, isAdmin, isChatModerator, isAppealModerator, frame` | – | required | R | CONFIRMED (session) |
| `PATCH /me` | Change pseudo `{ pseudo }` | | required | W | DISCOVERED |
| `GET /me/bootstrap` | Startup bundle `{ me, wishlist, packs, progress, notifications{items,unread}, dmUnread{unread}, access, notice, changelog, launch{me} }` | – | required | R | CONFIRMED (session) |
| `GET /me/collection?lean=1` | `[{ characterId, qty, listable, sellBlock, firstAt, locked, resaleLocked, resaleUntil }]`. The site computes sellable copies as `qty − locked − resaleLocked − 1` (one copy is always kept); `resaleLocked` = blocked 72 h after a purchase/trade | `lean=1` | required | R | CONFIRMED (session) |
| `GET /me/collection/prices?ids=1,2` | Market prices for owned cards | | required | R | DISCOVERED |
| `POST /me/collection/:id/recycle` | Destroy copies for chakra `{ qty }` | | required | W | DISCOVERED (not implemented: destructive) |
| `POST /me/collection/recycle-all` | Recycle all duplicates `{ rarities: [] }` | | required | W | DISCOVERED (not implemented: destructive) |
| `GET /me/progress` | Missions: `claimable, resets{nextDaily,nextWeekly}, daily{missions[],bonusClaimed}, weekly{…}, streak{day,claimedToday}, welcome{giftClaimed}, achievements[{id,label,progress,target,done,claimed}], series[{series,size,total,claimed}], referral, now`. Daily/weekly blocks also carry `period, allDone, bonusPacks / pack`; streak carries `nextDay, rewards[], lastDayPack, graceLeft, total`; welcome carries `quests[], done, gift` | – | required | R | CONFIRMED (session) |
| `POST /me/progress/claim` | Claim rewards `{ kind, id? }` -> `{ progress, user, gained{chakra?,bonusPacks?,grants} }` | kind: `all` \| `streak` \| `series` (id = series name) \| `achievement` (id) | required | **W** | CONFIRMED (session) |
| `GET /me/wishlist` / `PUT,DELETE /me/wishlist/:id` | Wishlist ids | | required | R / W | read CONFIRMED (session); write INFERRED, wrapped, not exposed in CLI |
| `GET /me/wishlist/odds` | Odds of wishlisted cards | | required | R | DISCOVERED (wrapped) |
| `GET /me/notifications?unread=1&limit=30`, `POST /me/notifications/read` | Notifications | | required | R / W | DISCOVERED |
| `GET /me/events?token=…` | Server-sent events (`notification`, `notice`, `dm`, `trade_msg`, `chat`) | token in query | required | R | DISCOVERED (not implemented; polling is used instead) |
| `GET /me/prestige`, `PATCH /me/profile`, `PUT /me/showcase` | Profile | | required | R / W | DISCOVERED |
| `/me/friends…`, `/me/dm…`, `/me/blocks/:id` | Friends and direct messages | | required | R / W | DISCOVERED (social features: not automated) |
| `POST /me/referrer` | Set referral code | | required | W | DISCOVERED (not automated) |
| `/me/push…`, `/me/membership…`, `/me/feedback…`, `/me/changelog…` | Push, membership, feedback | | required | R / W | DISCOVERED |

### Market & trades

| Method & path | Purpose | Params / body | Auth | R/W | Status |
|---|---|---|---|---|---|
| `GET /market/listings` | Search listings -> `{ items: Listing[], total }` | `q`, `rarity`, `series`, `type` (`auction`\|`fixed`), `characterId`, `sort` (`ending`\|`newest`\|`price_asc`\|`price_desc`), `page` (1-based), `pageSize` (≤ 50) | optional (adds `isMine`, `myMaxBid`, `leading`) | R | CONFIRMED (server rejects `pageSize > 50` and unknown `sort` with 400) |
| `GET /market/listings/:id` | One listing | `id` uuid | optional | R | CONFIRMED (404 "Annonce inconnue") |
| `GET /market/prices/:characterId` | `{ median7d, median30d, sales7d, sales30d, lastPrice, lastAt, lastSales[] }` | | none | R | CONFIRMED |
| `GET /market/buy-orders?characterId=` | Order book `[{ price, qty }]` | | none | R | CONFIRMED |
| `POST /market/listings/:id/bid` | Proxy bid `{ maxAmount }` (+ `x-pass` when available) -> `{ user, listing, leading }` | | required | **W** | CONFIRMED (session) |
| `POST /market/listings/:id/buy` | Buy fixed price / buyout -> `{ user, … }` | | required | **W** | INFERRED |
| `POST /market/listings` | Create a listing | body from the sell form | required | W | DISCOVERED (not implemented) |
| `POST /market/listings/:id/cancel` | Cancel own listing (deposit fee not refunded; refused with `has_bids`) | | required | W | DISCOVERED |
| `POST /market/buy-orders`, `…/:id/fill`, `…/:id/cancel` | Buy orders | | required | W | DISCOVERED |
| `GET /me/market` | Own activity `{ listings[], bids[], buyOrders[], holds[] }` (item shapes not pinned down yet) | | required | R | CONFIRMED (session) |
| `GET /me/market/access` | `{ allowed, reasons[], discord, accountAgeDays, boostersOpened, gating }`. The bot refuses bids/purchases early when `allowed` is false, showing `reasons` | | required | R | CONFIRMED (session) |
| `GET /trades/offers` | Public trade offers `[{ id, user, characterId, wantIds[], counterOk, status, createdAt, expiresAt }]` | filters via query | none | R | CONFIRMED |
| `GET /me/trades` | `{ incoming[], outgoing[] }` of `{ id, from{id,pseudo}, to{id,pseudo}, give{cards[{characterId,qty}],chakra}, want{…}, message, status (pending/accepted/declined/cancelled), offerId, createdAt, expiresAt (48 h), messages }` | | required | R | CONFIRMED (session) |
| `GET /trades/available/:userId` | That player's tradeable copies `[{ characterId, n }]` | | required | R | CONFIRMED (session) |
| `GET /trades/owned/:userId` | Character ids that player owns | | required | R | CONFIRMED (session) |
| `GET /fair-play/with/:userId` | `{ enabled, freeRatio, ignoreBelow, receivedDays, pairDays, giveLeft, getLeft, giveBalanceLeft, getBalanceLeft, myReceivedLeft, theirReceivedLeft }` | | required | R | CONFIRMED (session) |
| `GET /fair-play/prices?ids=` | Reference value per character `{ "<id>": chakra }` (≤ 200 ids) | | required | R | CONFIRMED (session) |
| `POST /trades` | Propose `{ toUserId, give{cards,chakra}, want{cards,chakra}, message?, counterOf?, offerId? }` -> `{ user, … }`; sent with `x-pass` like bids | | required | **W** | INFERRED |
| `POST /trades/:id/cancel` | Withdraw my pending proposal (unlocks the cards) | | required | **W** | INFERRED |
| `POST /trades/:id/accept`, `/decline`, `/trades/:id/messages` | Answer and talk in a trade | | required | W | DISCOVERED (not automated) |
| `GET /market/chat?room&limit&before` | `{ items[{ id, text, room, createdAt, author{id,pseudo,…}, attachment? }], hasMore }`. Attachments: `{ kind:'card', tag:'seek'\|'trade', character }` or `{ kind:'listing', listingId, … }` | | optional | R | CONFIRMED |
| `GET /market/chat/rooms` | `{ capacity, rooms[{ room, count }] }` | | optional | R | CONFIRMED |
| `GET /me/chat` | `{ canPost, reasons[], mutedUntil, maxLength }` | | required | R | CONFIRMED (session) |
| `POST /market/chat`, `/market/chat/join`, report, delete | Posting and moderation | | required | W | DISCOVERED (never used) |

**Anti-bot pass on market writes** (from the client): bids, buys, listings, buy orders,
trade proposals and offer acceptance are sent with the `x-pass` header when the site has a
pass, and a `pass_required` answer makes the site renew it and retry. The bot attaches its
stored pass the same way and reports `pass_required` instead of retrying.

Listing fields (CONFIRMED): `id, seller{id,pseudo}, character, type, price` (start or sale price), `buyoutPrice, currentBid, minNextBid, bidCount, createdAt, endsAt, status` (`active` observed), `finalPrice, isMine, myMaxBid, leading, prices`.

**Bidding semantics** (from the site's UI text): a bid is a *maximum*. The amount is set aside, not spent. If you win below it, the difference is refunded. If you are outbid, everything is refunded. If your maximum reaches `buyoutPrice`, the server answers `use_buyout`.

Market errors: `invalid_price, invalid_duration, not_listable, use_buyout, bid_too_low, own_listing, listing_closed, has_bids, too_many_listings, too_many_orders, too_many_trades, trade_closed, rate_limited, market_locked`.

### Rankings & community (public)

| Method & path | Purpose | Status |
|---|---|---|
| `GET /leaderboard` | Top 20 `[{ id, pseudo, avatar, frame, owned, mythics }]` | CONFIRMED |
| `GET /leaderboard/ladder?by=&me=&q=` | `{ by, rows[{pos,id,pseudo,owned,mythics,points,series,achievements,…}], me, total, catalogSize }`. `by` ∈ `collection`, `mythics`, `series`, `achievements` (other values fall back to `collection`) | CONFIRMED |
| `GET /feed` | Recent notable pulls site-wide | CONFIRMED |
| `GET /feedback/reviews` | `{ average, count, items[] }` | CONFIRMED |
| `GET /users/:uuid`, `GET /users/:uuid/cards/:id` | Public profiles (400 unless a UUID) | CONFIRMED (errors) / DISCOVERED |

### Not touched

`/api/admin/*` (staff tooling) exists in the bundle and is deliberately not used. The CLI's `api get` refuses it.

## Mapping of route names seen in DevTools

DevTools showed only the **last path segment**. The short top-level paths return 404 (CONFIRMED):

| Seen as | Real path |
|---|---|
| `collection?lean=1` | `/api/me/collection?lean=1` |
| `bootstrap` | `/api/me/bootstrap` |
| `news` | `/api/characters/news` |
| `heritage` | `/api/characters/heritage` |
| `listings?sort=ending&pageSize=4` | `/api/market/listings?sort=ending&pageSize=4` |
| `providers` | `/api/auth/providers` |
| `progress` | `/api/me/progress` |
| `claim` | `/api/me/progress/claim` |
| `odds` | `/api/me/wishlist/odds` |
| `launch` | `/api/launch` or `/api/me/launch` |
| `config`, `rates`, `feed`, `packs`, `leaderboard`, `reviews` (`/feedback/reviews`), `push`, `me` | as listed above |
