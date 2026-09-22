# Order Alert Bot — Deep Dive

This is the internal reference doc for this project. The `README.md` is the quick-start;
this file is "everything you need to know to work on this without re-discovering it."

## 1. What this project is for

Rangrooh sells on **Myntra M-Direct** and **Amazon Seller Central**, self-shipping every order.
Neither platform gives this seller account an official API to get notified of new orders in
real time. This app fills that gap:

- Polls both marketplaces on a timer.
- Sends a Telegram alert (photo + SKU + size/color + stock level) the moment a genuinely new
  order shows up.
- Automatically pushes the order into the sister **stock-manager** project's "Ready to Ship"
  queue, so it's already waiting there — no manual re-entry.
- Alerts on Myntra cancellations too.
- Alerts you if either marketplace session expires, so orders don't silently stop being seen.

It is a small Next.js app with a password-gated single admin page (the dashboard), deployed on
Vercel, with its own MongoDB Atlas database for its own bookkeeping (separate from
stock-manager's database).

## 2. Why this works the way it does (no official API)

Neither Myntra M-Direct nor this Amazon Seller Central account tier expose a public seller API
for order events. Both integrations work by **replaying the same internal JSON request the
platform's own seller-portal frontend makes**, using a session captured from a real logged-in
browser.

**Automated login is blocked, confirmed by actually testing it** (not just assumed): driving a
real headless/headed browser (Playwright) through Myntra's login form failed immediately with
`net::ERR_HTTP2_PROTOCOL_ERROR` on the very first request to `accounts.myntra.com`, which carries
Akamai bot-management cookies (`bm_sz`, `ak_bmsc`, `_abck`) — Myntra's anti-bot layer disrupting
the connection right at the login gate. That gate is *not* pursued further (matching real
bot-detection is the kind of thing this project won't try to defeat), so **logging in stays a
manual, human action, done in a real browser, forever.**

The same is true for Amazon Seller Central, likely more so: it's a financial/business account, so
Amazon made **two-step verification mandatory for every Seller Central login since March 2024,
with no opt-out** — even Seller Support cannot disable it for anyone, by Amazon's own policy
(confirmed 2026-09-22 via Seller Central's own forums). A passkey can be added as an *alternative*
sign-in method, but does not replace or skip the OTP step — sellers report the OTP prompt still
appears even with a passkey configured. Automating a login would therefore also mean automating
that OTP (reading an SMS/authenticator code programmatically), which either doesn't work or means
handing the automation the means to log in as you from anywhere — not something this project
does. So both marketplaces land on the same rule: **logging in stays a manual, human action.**

What *is* now automated: getting the resulting session into this app, which used to be the
recurring manual step (§7, §18) and no longer has to be. The orders API itself turned out to be
far less guarded than the login page — proof of that is this whole app already working via plain
cookie replay with zero browser/JS involvement — so a small **browser extension**
(`browser-extension/`, §18) reads the session cookies straight out of Chrome's cookie jar
(including the HttpOnly ones DevTools needs a manual copy for) of an already-logged-in session,
and posts them to this app on a timer. No password, no login automation, no bot-detection
involved in that step at all — it only ever reads cookies that already exist because a human
logged in normally.

- Myntra: `partnersapi.myntrainfo.com/api/mdirect/orders/...`
- Amazon: `sellercentral.amazon.in/orders-api/search`

Because this is an unofficial, reverse-engineered integration, it can break if either platform
changes its frontend, and the session **will** expire periodically (this app alerts you when
that happens — see §7).

## 3. High-level architecture

```
cron-job.org (external, 24/7)                 Vercel (this app)                stock-manager (sister app)
─────────────────────────────                 ─────────────────                ──────────────────────────
GET /api/check-orders?secret=...        ──►    poll Myntra                ──►   POST /api/pending
GET /api/check-amazon-orders?secret=... ──►    poll Amazon                ──►   POST /api/pending
GET /api/check-cancellations?secret=... ──►    poll Myntra cancellations
GET /api/check-otc?secret=...           ──►    poll pickup/return OTC (§19, 12:00-13:00 IST only)
                                                       │
                                                       ├──► Telegram (order/cancel/OTC alerts,
                                                       │     routed by Owner/Viewer role — §20)
                                                       │
                                                       └──► its own MongoDB (session, status,
                                                            seenOrders, seenAmazonOrders,
                                                            seenCancellations, recipients,
                                                            recipientRoleHistory)
```

**Key fact: none of this depends on your laptop, browser, or the dashboard being open.**
The checking logic runs entirely on Vercel's servers, triggered by an external scheduler
(cron-job.org), not by anything in the browser. See §14 for the full "how it works when the
site is closed" explanation.

There is **no Vercel Cron** here — Vercel's Hobby plan cron is capped at once/day, far too slow
for near-real-time alerts, so **cron-job.org** (a free external scheduler) is used instead,
configured to hit the three `/api/check-*` endpoints directly.

## 4. Environment variables (`.env.local` / Vercel project settings)

| Variable | Purpose |
|---|---|
| `TELEGRAM_BOT_TOKEN` | Bot used to send all alerts |
| ~~`TELEGRAM_CHAT_ID`~~ | **No longer read anywhere in this codebase (as of 2026-09-22).** Replaced by the DB-driven `recipients` collection (§20) — safe to remove from Vercel whenever, or leave, doesn't matter either way |
| ~~`TELEGRAM_COMMAND_CHAT_ID`~~ | **No longer read anywhere in this codebase (as of 2026-09-22).** Both its old jobs (who gets owner-only alerts, who can issue bot commands) are now Owner-role-driven from the `recipients` collection instead (§20) |
| `ROLE_CHANGE_PASSWORD` | Second password required (on top of `ADMIN_PASSWORD`) to change a recipient's role or remove them — §20 |
| `WAREHOUSE_ID` | Myntra warehouse ID used in its API URLs (default `89623` if unset) |
| `ADMIN_PASSWORD` | Password for the dashboard login; also the literal value stored in the `admin_auth` cookie |
| `CRON_SECRET` | Shared secret cron-job.org must pass as `?secret=` on every check endpoint |
| `EXTENSION_SYNC_SECRET` | Shared secret the browser extension sends as `x-sync-secret` on `POST /api/session/sync` (§18) |
| `RESOLVE_RETURN_SECRET` | Shared secret stock-manager's backend sends as `x-resolve-secret` on `GET /api/resolve-return` (§21) — the one call that goes stock-manager → this app; every other integration point goes the other way |
| `MONGODB_URI` | This app's own MongoDB Atlas connection string |
| `MONGODB_DB` | This app's own DB name (defaults to `myntra_alerts`) |
| `STOCK_MONGODB_URI` | **Read-only** connection to stock-manager's MongoDB, for live stock lookups |
| `STOCK_MANAGER_URL` | Base URL of the stock-manager deployment (defaults to `https://stock-manager-niko.vercel.app`) |
| `STOCK_MANAGER_AUTH_TOKEN` | Sent as `Cookie: auth=<token>` on every call to stock-manager's `/api/pending*` — must equal whatever stock-manager's own login sets as that cookie's value |

### Telegram recipients

Superseded 2026-09-22 by the DB-driven, dashboard-managed Owner/Viewer/None role system — see
**§20** for the full design. The three people who used to be hardcoded here (Gaurav, Mukesh
Bhandari, Alka Bhandari) were migrated into it at the roles they already effectively had
(`scripts/seed-recipients.js`), so nothing changed for them functionally.

## 5. Data model (this app's own MongoDB — `MONGODB_DB`)

Everything lives in one `settings` collection (by `_id`) plus a few small tracking collections:

- `settings/_id:'session'` — `{ headers, capturedAt, source }` — Myntra session (parsed request
  headers); `source` is `'manual'` (admin-page paste) or `'extension'` (§18) — display-only, both
  are read identically by every check
- `settings/_id:'session_amazon'` — same shape, for Amazon
- `settings/_id:'status'` — one shared status doc:
  - `running` (bool) — the Start/Stop switch. **This is the master gate**: every cron tick
    checks this first and no-ops if false.
  - `lastCheck`, `openCount`, `lastError`, `sessionExpiredAlertSent` — Myntra
  - `amazonLastCheck`, `amazonOpenCount`, `amazonLastError`, `amazonSessionExpiredAlertSent` — Amazon
  - `lastCancelCheck`, `cancelledCount`, `lastCancelError` — Myntra cancellations
- `settings/_id:'otc_status'` — `{ alertedDate, alertedAt, values, errorAlertedDate }`, the OTC alert's own dedup flags (§19): both are IST `YYYY-MM-DD` strings, compared against today so a new day always gets a fresh chance to alert without anything having to reset it. `alertedDate` guards the success ping (a real code found); `errorAlertedDate` separately guards the missing/expired-session ping, so the two never interfere with each other.
- `seenOrders` — `{ _id: orderId, seenAt }` — every Myntra order ID the poller has ever fetched (whether or not it turned into an alert). This is the de-dup ledger; an order ID here is never alerted again.
- `seenAmazonOrders` — same, for Amazon (`_id: amazonOrderId`)
- `seenCancellations` — same idea, for Myntra cancelled-order IDs
- `recipients` — `{ _id: chatId, chatId, name, username, role: 'OWNER'|'VIEWER'|'NONE', protected, firstSeenAt, lastSeenAt }` — who gets what alerted, and who can issue bot commands (§20). `_id` is the Telegram chat id itself.
- `recipientRoleHistory` — `{ chatId, name, fromRole, toRole, changedAt }`, append-only, one row per role change — never touched by deleting a recipient (§20).

**"New" is defined purely as "order ID not yet in `seenOrders`/`seenAmazonOrders`."** Nothing
here tracks whether the underlying order is later shipped, cancelled, edited, etc. — that state
lives entirely in stock-manager's Ready to Ship queue.

## 6. The cron endpoints

| Endpoint | Suggested frequency | What it does |
|---|---|---|
| `GET /api/check-orders?secret=CRON_SECRET` | ~1 min | Poll Myntra open orders, alert + queue new ones |
| `GET /api/check-amazon-orders?secret=CRON_SECRET` | ~1 min | Poll Amazon unshipped orders, alert + queue new ones |
| `GET /api/check-cancellations?secret=CRON_SECRET` | ~30 min | Poll Myntra cancellations, alert on new ones |
| `GET /api/check-otc?secret=CRON_SECRET` | ~5 min | Pickup/return OTC alert — see §19, shape is different from the three below (no seen-collection, time-window + once-per-day gated instead) |

The first three:
1. Reject with 401 if `?secret=` doesn't match `CRON_SECRET`.
2. Read `settings/_id:'status'.running` — **if false, return `{ skipped: true, reason: 'stopped' }` immediately and do nothing else.** This is why "Stop" reliably silences everything even though the external scheduler keeps ticking every minute regardless.
3. If running, fetch from the marketplace, diff against the seen-collection, alert + queue anything new, then mark everything fetched as seen (including things that weren't "new" — a session that expired and got refreshed won't re-alert stale orders it already knew about before the outage... but *will* alert orders it never got the chance to see. See §14.)
4. On a 401/403 from the marketplace (session expired), sends exactly one Telegram warning (guarded by the `sessionExpiredAlertSent`/`amazonSessionExpiredAlertSent` flag so it doesn't repeat every minute) and records the error for the dashboard.

`check-cancellations` has one extra rule: **on its very first-ever run** (empty `seenCancellations`
collection), it seeds silently instead of blasting a cancellation alert for the entire historical
backlog.

`check-otc` still respects the same `running` gate (still a no-op when stopped), but everything
else about it is different — see §19.

## 7. Dashboard (`app/page.js`) admin actions

Password-gated (cookie `admin_auth`, set by `/api/login`, compared directly against
`ADMIN_PASSWORD` — no hashing, no sessions table, this is intentionally minimal).

- **Start** (`POST /api/admin/start`) — sets `running: true`, then immediately runs both Myntra
  and Amazon checks synchronously (so it "catches up" right away instead of waiting up to a
  minute for the next cron tick).
- **Stop** (`POST /api/admin/stop`) — sets `running: false`. Cron ticks keep firing every minute
  but every one becomes a no-op.
- **Check now** (`POST /api/admin/check-now`) — runs both checks immediately, **regardless of
  the running flag** (does not check or change it). Useful for testing without toggling Start.
- **Refresh session** (Myntra/Amazon forms) — paste a `curl` command or a raw DevTools "Headers"
  panel dump; `lib/curl.js` parses either format into a headers object (handles both `-H
  'cookie: ...'` and `-b '...'` cookie styles, and both `-H` cURL flags and the two-line
  header-dump format). Strips `content-length`/`accept-encoding`/`connection` since those are
  meaningless when replayed from a server. Both this route (`app/api/session/route.js`) and the
  extension's sync route (`app/api/session/sync/route.js`, §18) call the same
  `lib/sessionStore.js`'s `saveSession()` to actually write it — same DB write, same
  "✅ session activated" confirmation either way, just a different capture method (and a
  different auth check: admin cookie here, a shared secret there). That confirmation is sent
  **silently** (`disable_notification`) on purpose, since with the extension running it's a
  routine every-few-hours all-clear, not something worth a buzz — unlike session-*expired*, which
  stays noisy.
- **Platform filter** / **theme toggle** / **hide past-ship-by orders** — pure display, no
  server effect.

The page polls `/api/status` and `/api/orders` every 20s while logged in (`REFRESH_MS`), so it
stays live without a manual refresh — but again, this is only for *your viewing*; it has no
bearing on whether alerts fire (see §14).

**Deliberate exception, "Myntra packed today" stat card (added 2026-09-22)**: every other
dashboard stat is either DB-read (cheap, safe to poll every 20s) or already covered by the
cron checks. This one calls `/api/packed-count`, which hits Myntra's live `getPostPackedOrders`
API directly, on request. That call is made **once, only when the page is opened** — it is
*not* in the 20s interval loop (`loadPackedCount()` is called in the mount effect but left out of
`setInterval`'s body, on purpose) — a manual "Refresh" button on the card is the only other way
to trigger it. Leaving the dashboard tab open must never cause a recurring background Myntra call
just because the interval ticked. (Briefly moved into the 20s loop, then reverted the same day —
the user explicitly wants this manual-only, not real-time-polled.)

**"Packed" means `packetStatus === 'PACKED'`, not "any packet packed today" (fixed 2026-09-22)**:
`getPostPackedOrders` returns every packet packed within the queried date range regardless of
what's happened to it since — a real production capture showed rows with `packetStatus: "PICKED"`
and `"SHIPPED"` mixed in with `"PACKED"` ones (and `packedOn` timestamps spanning well before the
queried day). `fetchPackedCount()` originally counted every row returned, which overcounted
"packed" with orders that had already been picked up by the courier or shipped. It now filters to
`packetStatus === 'PACKED'` before summing — real incident: showed 20 for 2026-09-22 when
everything for that day had already moved past PACKED; filtering brought it to the correct 0.
This is shared by both the dashboard card and the `/packed`/`/packedall` bot commands (§ file map).

## 8. Order-processing pipeline (per new order, per marketplace)

1. Fetch the order's line items.
   - **Myntra** (`fetchOrderItems` in `lib/myntra.js`): the API returns **one row per physical
     unit** — a qty-2 order of one variant comes back as two identical rows. This function
     groups them by SKU internally and returns one entry per unique SKU with a `.qty` field.
   - **Amazon** (`groupAmazonItemsBySku` in `lib/amazon.js`): same idea, summing
     `quantityOrdered` per `sellerSku`.
   - **This SKU-level grouping must happen before anything else touches the items** — it was
     added specifically to fix a real bug (see §12) where per-unit rows caused an idempotency
     check to block the 2nd unit of a qty-2 order instead of merging it, undercounting Ready to
     Ship by 1.
2. Compute the header text (`formatOrderHeader` / `formatAmazonOrderHeader`) — Order ID, Placed,
   Ship by, and a bold `MULTI ORDER (N items)` line when there's more than one distinct SKU.
3. For each item: look up live stock (§9), push it into stock-manager's Ready to Ship queue
   (§10), and build its caption text (SKU, size/color, qty, stock line).
4. Send everything as **one Telegram message per order** (§11).
5. Mark the order ID as seen.

## 9. Stock lookup (`lib/stock.js`) — read-only

- Connects directly to **stock-manager's own MongoDB** (`STOCK_MONGODB_URI`) and reads its
  `skustocks` collection — never writes here.
- SKUs differ by brand prefix across marketplaces for the *same* physical variant
  (`RRC-010-CO-C-RED-M` / `RR-010-CO-C-RED-M` / `R-010-CO-C-RED-M`) — the lookup strips
  everything before the first `-` and matches on the suffix via a regex anchor (`-<suffix>$`).
- Stock is tracked per `(sku, locationCode)` in stock-manager, and only locations whose `kind` is
  `SELLABLE` (its `locations` collection) count toward "available" — `DAMAGED`/`QUARANTINE` stock
  is real on-hand inventory but never sellable. `getSellableLocationCodes()` in this file queries
  and caches those codes (same lazy-cache pattern as the Mongo client), then `lookupStock()` sums
  only `skustocks` docs whose `locationCode` is in that set — mirroring stock-manager's own
  `getProductGroups()` filter exactly, so the alert's number matches its dashboard. A SKU with
  matching docs but zero sellable ones (e.g. only a `DAMAGED` row) correctly shows 0 available /
  OUT OF STOCK, not "not found" — only a total absence of matching `skustocks` docs is "not found."
- Some product codes are **bundles** that draw stock from a *different* product's pool (e.g.
  "Halter with Palazzos" physically ships as a "Halter Neck" top). `BUNDLE_CODE_MAP` in this
  file (`{'012':'002', '013':'001'}`) mirrors stock-manager's own `BUNDLE_STOCK_PREFIX` constant
  — **this is intentionally duplicated, not imported**, because this app was built to never
  import or directly touch stock-manager's codebase. **If stock-manager's bundle mapping ever
  changes, this map must be updated by hand.**
- Stock classification (`classify()`, still exactly this): `available = onHand - reserved`;
  `available <= 0` → level `'out'`, `<= 5` → level `'low'` ("Low (N left)"), else level `'ok'`
  ("N available"). `stock.level`/`stock.available` themselves are used as-is everywhere else
  (the admin dashboard, etc.) — untouched.
- **Display-only override in `formatStockLine()` (added 2026-09-22)**: exactly-zero `available`
  now renders in the Telegram caption as `Stock: 🟡 Low (1 left)` instead of the red `OUT OF
  STOCK` line — deliberately softened outward-facing text, business decision, not a bug. Genuinely
  **negative** `available` (oversold — more reserved/queued than physically on hand) is a strictly
  worse signal than plain zero and still renders as `OUT OF STOCK`, unchanged. This override lives
  only in `formatStockLine()`'s text, so nothing else that reads `lookupStock()`'s return value
  (the dashboard's `app/page.js`, `/api/orders`) is affected — they still show the real level/number.
- Any failure here (bad SKU match, Mongo hiccup) returns `null` silently — a stock-lookup
  problem must never block the alert itself.

## 10. Ready-to-Ship integration (`lib/readyToShip.js`) — writes, via HTTP only

**Critical rule: this app must never write to stock-manager's MongoDB directly.**
`PendingShipment.qty` has to stay in lockstep with `SkuStock.reserved` on stock-manager's side,
and only stock-manager's own API (`addPending`/`cancelPending`/etc., in its `src/lib/shipping.ts`)
knows how to keep that in sync. All mutations go through:

- `POST {STOCK_MANAGER_URL}/api/pending` with `{ sku, qty, channel, orderId, placedAt, shipByAt }`,
  authenticated via `Cookie: auth=<STOCK_MANAGER_AUTH_TOKEN>`.
- Before posting, the SKU is canonicalized to stock-manager's own brand prefix: everything after
  the first `-` gets re-prefixed with `RRC-` (verified: 327/328 of stock-manager's current
  catalog uses that prefix). Bundle-code remapping (012→002 etc.) is **not** duplicated here —
  stock-manager's own `addPending` already does that internally.
- Before posting, `alreadyTracked()` calls stock-manager's `GET /api/pending/check?orderId=...`
  (the same duplicate-detector its manual "+Add" form uses) to make this idempotent — if this
  app's own `seenOrders` tracking is ever wiped (e.g. during a manual cleanup, see §15) and it
  re-processes an order it already queued, this prevents silently doubling the reservation.
- Every call is best-effort: on any failure (missing SKU match, stock-manager error, network
  issue) it logs and returns `{ ok: false, error }` **without throwing** — a Ready-to-Ship hiccup
  must never prevent the Telegram alert from going out.

## 11. Telegram message format — current design

One message per order (not one per item, not a separate header message). This went through two
iterations worth knowing about, because the reasoning matters if it needs to change again:

1. **First attempt**: send the header as its own `sendMessage`, then the item photo(s) as a
   separate `sendPhoto`/`sendMediaGroup`. This always rendered as **two separate chat bubbles**
   even sent milliseconds apart — confusing, looked like unrelated alerts.
2. **Current design**: the header text is **prepended into the first photo's caption**, and for
   a multi-item order, **every item's SKU/size/stock line is joined into that same single
   caption** (`header + '\n\n' + captions.join('\n\n')`), attached only to the first photo in
   the `sendMediaGroup` call. The other photos in the album carry no caption.
   - **Why not one caption per photo**: Telegram's media-group album only surfaces the *first*
     photo's caption inline in the chat — this is most visible on **mobile**, where the other
     items' captions are completely hidden until you tap into the album; desktop clients are
     more forgiving but the behavior isn't guaranteed. Putting all item detail in the one
     caption slot that's guaranteed visible fixed this for every client.
   - `photos.length === 0` → plain `sendTelegramMessage(combinedCaption)` (no image available for
     any item).
   - `photos.length === 1` → `sendTelegramPhoto` (Telegram requires 2+ items for a media group).
   - `photos.length > 1` → `sendTelegramMediaGroup`.
   - Caption length: Telegram caps photo/album captions at 1024 characters. A single item's
     block is ~90–120 chars; the header is ~100–150. In practice this comfortably fits orders up
     to 5–6 distinct SKUs. **If a legitimately huge multi-SKU order ever gets truncated, that's
     the limit to know about** — the fix would be to split overflow items into a follow-up plain
     `sendTelegramMessage`.
- `lib/telegram.js` is the only file that talks to the Telegram Bot API (`sendMessage`,
  `sendPhoto`, `sendMediaGroup`, all `parse_mode: 'HTML'`). Telegram's HTML mode has no color
  support — "OUT OF STOCK" uses bold + a 🔴 emoji as the closest visual equivalent to red.

## 12. Notable bugs fixed here (context for future changes)

- **Timezone**: Vercel's server clock is UTC. All customer-facing dates go through
  `lib/dates.js`'s `formatIST`/`formatISTDate` (explicit `timeZone: 'Asia/Kolkata'`) — never use
  a bare `.toLocaleString()`/`new Date().toString()` anywhere alerts or the dashboard render
  dates, or it'll silently show UTC.
- **Myntra ship-by date**: Myntra's own `packByTime` field is not a real deadline (sometimes
  only minutes after order placement). The actual seller rule: an order placed before 1pm IST
  ships same-day; at/after 1pm IST ships next-day. `myntraShipByDateMs()` in `lib/dates.js`
  implements exactly this, returning the **end** of the deadline day (23:59:59.999 IST) — using
  the start of the day here previously caused every dashboard's "hide past ship-by orders"
  filter to hide same-day orders instantly at midnight-IST-as-UTC-conversion, which looked like
  "all Myntra orders vanished."
- **SKU aggregation vs. idempotency race**: adding a per-order idempotency check (§10) exposed a
  bug where Myntra's one-row-per-unit API response caused the 2nd unit of a qty-2 order to be
  seen as "already tracked" and get dropped instead of merged, undercounting the Ready to Ship
  queue. Root-fixed by grouping items by SKU (§8) *before* anything else sees them, rather than
  patching the idempotency check further.
- **Missing-session alert gap (open, unresolved)**: `runCheckOrders()` throws a plain
  `'No session saved yet'` error *before* the try/catch that sends the session-expired Telegram
  alert, if `settings/_id:'session'` doesn't exist at all (found by deliberately deleting it to
  test the extension's recovery). A session that **expires** (a real 401/403 from Myntra) alerts
  correctly; a session that's **entirely missing** currently fails silently — logged as
  `lastError` on the dashboard, no Telegram ping. In practice this is a narrow window (the
  extension re-syncing, or a real expiry, are far more common than the session vanishing
  outright), but it's a real gap worth closing — wrap the missing-session throw in the same alert
  path 401/403 uses.
- **Amazon 8-orders detection gap (open, unresolved)**: at one point 8 real "Waiting for pick-up"
  Amazon orders were completely invisible to `fetchUnshippedOrders()` across every combination of
  `orderStatus` (`pending`/`unshipped`) × `program` (`easyship`/`selfship`) tried. Those 8 were
  added to Ready to Ship manually as a workaround. **If this happens again**: ask exactly which
  Seller Central page/tab/filter shows the missing orders, since `searchUrl()` in `lib/amazon.js`
  may need additional query params to match that view.
- **Stock number in alerts was read before this order's own reservation landed (fixed
  2026-09-20)**: `sendOrderAlert()` in `checkOrders.js`/`checkAmazonOrders.js` used to call
  `lookupStock()` *before* `addToReadyToShip()`, so the "N left" shown in the Telegram alert
  didn't yet include the very order it was alerting about — e.g. an alert reading "Low (1 left)"
  while stock-manager's own dashboard, updated a moment later by that same order's reservation,
  already read 0. Fixed by reserving first, then reading stock, so the number shown is the real
  post-order figure that matches stock-manager immediately after.
- **Unmatched SKU silently dropped the whole "Stock:" line (fixed 2026-09-20)**:
  `formatStockLine()` in `lib/stock.js` returned `''` when `lookupStock()` found no matching SKU
  in stock-manager (typically: the variant hadn't been added to the catalog yet) — indistinguishable
  from a bug, since the line just vanished from the caption with no explanation. Now renders
  `Stock: ⚠️ not found in stock manager` instead, so it's obviously "go add this product" rather
  than "something broke."
- **Partial cancellation on a multi-item order wiped the WHOLE order out of Ready to Ship (fixed
  2026-09-20, real incident: order 6026100011)**: Myntra's per-order item-detail endpoint
  (`fetchOrderItems()` in `lib/myntra.js`) returns one row per physical unit, each carrying its
  OWN `status` (`CREATED`/`CANCELLED`) — a multi-item order can have some units cancelled while
  others still ship. This was ignored entirely: rows were grouped by SKU regardless of status, so
  a still-live unit could get folded into the same bucket as an already-cancelled one sharing the
  same SKU. Two orders in this exact order (2 Red-XS units, one of which was cancelled 16s after
  placement, plus 1 untouched White-XS unit): the **new-order alert** showed Red as `Qty: 2`
  (only 1 was ever genuinely live), and the **cancellation alert** claimed White was cancelled too
  even though it was never touched. Worse: `removeCancelledOrdersFromQueue()` in
  `lib/pendingQueue.js` deleted **every** Ready-to-Ship row for the order on any cancellation
  (it had no way to know only one line was cancelled) — this order's entire queue entry, Red *and*
  White, was wiped, including the still-live units, releasing their reserved stock. Manually
  re-added via `addToReadyToShip()` after the fix landed.
  Fixed by: (1) `fetchOrderItems(orderId, headers, statuses)` now takes a `statuses` filter —
  `checkOrders.js` passes the default `['CREATED']` (only genuinely open units), `checkCancellations.js`
  passes `['CANCELLED']` (only what was actually just cancelled); (2) a new
  `removeCancelledLinesFromQueue()` in `lib/pendingQueue.js` removes exactly the cancelled
  `{orderId, sku, qty}` lines (matched by SKU suffix, same convention as `lib/stock.js`), never
  the whole order — the old whole-order `removeCancelledOrdersFromQueue()` is kept only as a
  fallback for the rare case where an order's item-detail fetch itself fails.
- **Browser extension: Amazon session lasting ~12h instead of the account's normal 3-4 days
  (mitigated 2026-09-20)**: a manually-pasted session (DevTools "Copy as cURL") carries a real
  browser's full header set; the extension's auto-sync only ever built `cookie` + `user-agent` +
  a couple of static headers. Amazon's fraud detection already 403s some requests on this session
  (see `lib/amazon.js`'s `getWithRetry` comment) — replaying a bare, non-browser-shaped header set
  ~1,400 times/day is a plausible reason sessions now die much sooner. `browser-extension/background.js`'s
  `buildHeaders()` now adds `accept-language`, `origin`/`referer`, `sec-fetch-*`, and
  `sec-ch-ua*` (from this browser's own `navigator.userAgentData`) for Amazon specifically —
  Myntra untouched since its session already lasts fine. If sessions are still short after this,
  the other lever is the *frequency* of the external cron-job.org poll hitting
  `/api/check-amazon-orders` (currently ~1/min) — that's outside this repo, configured on
  cron-job.org's own dashboard.
- **No signal if the extension's 4h auto-sync silently stopped working (added 2026-09-20)**: a
  successful scheduled sync is deliberately silent (see §18) to avoid the alternating
  activated/expired spam loop a flag-touching announcement caused before — but that also meant a
  *real* failure (Chrome closed, sync broken past its own retry backoff) had no signal until the
  marketplace session eventually expired on its own, up to ~24h later. Two additions close this
  gap without reintroducing the spam loop: `lib/sessionSyncWatchdog.js` alerts if an
  extension-sourced session hasn't refreshed in 6+ hours (checked on every `/api/check-orders`
  tick, regardless of the running/stopped flag), and `lib/sessionStore.js#announceScheduledSyncOk()`
  sends a quiet, Gaurav-only heartbeat on every successful *scheduled* sync (tagged
  `scheduled: true` only by the main `SYNC_ALARM` firing, never a backoff retry) — it deliberately
  never touches the expired-alert flag, which is what keeps a retry storm from turning it into the
  same spam loop as before.
- **Cancelling an order that was already shipped left it stuck in Shipped (fixed 2026-09-20)**:
  `removeCancelledLinesFromQueue()` (§12, above) only ever removes rows from Ready to Ship — if a
  cancelled line's units were already shipped by the time the cancellation was seen, none of them
  are found there, so nothing happened and the order sat in stock-manager's Shipped history
  forever with its stock still deducted. `runCheckCancellations()` now treats that shortfall
  (whatever `removeCancelledLinesFromQueue` couldn't find) as "already shipped" and calls
  `lib/pendingQueue.js#unshipCancelledLines()`, which hits a new stock-manager endpoint,
  `POST /api/pending/unship-cancelled { orderId, sku, qty }` — presumed RTO (the courier brings
  the parcel back), so it restores the stock but deliberately does **not** re-add anything to
  Ready to Ship (there's no live order left to ship it to). Whatever still can't be resolved either
  way (not in the queue, not fully reversible in Shipped) gets a primary-chat alert to check
  manually, same pattern as `alertQueueFailure` in `checkOrders.js`.
- **Damaged/quarantined stock counted as "available" in alerts (fixed 2026-09-20, real incident:
  order 6026448343)**: `lookupStock()` in `lib/stock.js` summed `onHand`/`reserved` across
  *every* `skustocks` doc matching a SKU suffix, with no filter on `locationCode`. A SKU with
  stock split across `MAIN` (sellable) and `DAMAGED` (write-off, not sellable) had both pooled
  together — e.g. `RRC-007-CO-C-RED-S` at `MAIN: onHand 6/reserved 1` + `DAMAGED: onHand 2/reserved 0`
  showed as "7 available" in the Telegram alert, while stock-manager's own dashboard (which
  correctly filters to `Location.kind === 'SELLABLE'`) showed 5. Fixed per §9 above: `lookupStock()`
  now filters to sellable locations only, so the alert always matches the dashboard.
- **Pickup/return OTC alert added (2026-09-22)** — new feature, not a bug fix. See §19.
- **Telegram alert recipients moved from env vars to a DB-driven Owner/Viewer/None role system
  (2026-09-22)** — also unifies bot-command access (`/ship`, `/make`, ...) onto the same Owner
  role, adds a protected founding-Owner row, a second password for role changes, and a
  role-change history log. See §20.
- **Amazon session still dying in minutes-to-hours even after the 2026-09-20 header-realism fix
  (investigated 2026-09-22, unresolved)**: real session-history data pulled from production showed
  lifespans ranging from 1 minute to ~12 hours, no clear pattern — the header fix helped somewhat
  but didn't fix the underlying cause. Leading suspects, in order of likelihood: (1) the access
  **pattern** itself (an internal orders-API request every 1-5 minutes, 24/7, forever, is not
  something a real user's browsing ever looks like, regardless of how browser-like the headers
  are), and (2) **IP/network mismatch** — the session is born on the seller's real home/office
  network via the browser extension, then every replayed request comes from Vercel's data-center
  IPs instead, which is exactly the kind of signal marketplace fraud detection watches for.
  Slowing the cron-job.org poll interval (already done — set to 5 min, was ~1 min) did **not**
  meaningfully fix it, which weakens the "it's just the polling rate" theory and points more at
  the IP mismatch. Two real options if this needs solving properly: (a) route requests through a
  residential/India-based proxy to match the original login's network — flagged to the user as a
  real risk to the Seller Central account itself (Amazon's ToS almost certainly prohibits
  disguising automated traffic as a real user), not something to build silently; (b) migrate to
  Amazon's official Selling Partner API (SP-API) — the only option with no expiry problem at all,
  since it's sanctioned access rather than session replay. SP-API access itself is free as of
  2026-09-22 (Amazon proposed then cancelled a $1,400/year developer fee earlier in 2026), but
  registration + building a real OAuth integration is still a real, separate engineering effort.
  Automated re-login is **not** on this list — Amazon Seller Central requires 2-step verification
  on every login with no opt-out (confirmed via Seller Central's own forums), and a passkey does
  not replace or skip that OTP step, so there's no login flow here that could be automated even in
  principle without also automating OTP retrieval.

## 13. File map

```
lib/
  db.js                 this app's own Mongo connection (cached across warm serverless invocations)
  stock.js              read-only stock lookup against stock-manager's DB (§9); lookupProductBySku() for §22, added 2026-09-22
  readyToShip.js         writes to stock-manager's Ready to Ship queue via its HTTP API (§10)
  dates.js               IST formatting + the Myntra ship-by cutoff rule (§12)
  curl.js                 parses pasted cURL / DevTools header-dump text into a headers object
  telegram.js             the only file that calls the Telegram Bot API
  adminAuth.js            session-token cookie (admin_auth) against the `sessions` collection; getCurrentAccount()/isAuthed()/createSession()/destroySession() (§23, rewritten 2026-09-22 — was a single shared ADMIN_PASSWORD)
  accounts.js             the `accounts` collection — dashboard login accounts, Owner/Viewer roles, scrypt password hashing (§23, added 2026-09-22)
  monitorState.js         getRunning/setRunning on settings/_id:'status'.running
  myntra.js                Myntra API calls + per-order/per-item Telegram text formatting; fetchPackedCount() (getPostPackedOrders, paginated) for /packed; resolveReturnByTrackingId() (SPF claim -> packed-order lookup) for /api/resolve-return, see §21 (added 2026-09-22)
  amazon.js                Amazon API calls + per-order/per-item Telegram text formatting
  checkOrders.js           orchestrates one Myntra poll cycle (fetch → diff → alert → queue)
  checkAmazonOrders.js     same, for Amazon
  checkCancellations.js    orchestrates the Myntra-cancellations poll cycle
  checkOtc.js              pickup/return OTC poll cycle — time-window + once-per-day gated, not the seen-collection pattern (§19)
  otcConfig.js             the OTC alert's Owner-vs-Broadcast recipient-scope setting (§19)
  pendingQueue.js          removes cancelled orders/lines from stock-manager's queue, or un-ships them if already shipped, via its HTTP API (§12)
  sessionSyncWatchdog.js   alerts if an extension-sourced session goes stale (§12, §18)
  sessionStore.js          shared save-a-session logic (§18) — used by both session routes below
  recipients.js            the `recipients`/`recipientRoleHistory` collections — who gets alerted, who can run bot commands, role-change audit log (§20)
  telegramCommands.js      fetchQueueSummary() (reads stock-manager's `/api/pending/summary`) + one formatXList() per bot command's text — /ship, /make, /myntra(all/left), /amazon(all/left), /ready(all), /notready(all); toDMY()/todayIst() + formatPackedCount() for /packed(all) (added 2026-09-22)
  returns.js               addReturnToStockManager() — POSTs a Myntra return to stock-manager's own /api/register, same auth pattern as addToReadyToShip() (§22, added 2026-09-22)
components/
  BarcodeScanner.js        full-screen camera barcode scanner (@zxing/browser), plain JS/JSX port of stock-manager's own BarcodeScanner.tsx (§22, added 2026-09-22)
app/
  page.js                  the dashboard (login form + admin UI + order grid + Alert recipients + Role change history + Scan a Myntra return)
  api/telegram-webhook/route.js   Telegram's webhook target — command parsing/dispatch, Owner-gated (§20)
  globals.css              all dashboard styling, theme (light/dark) CSS variables
  api/
    check-orders/route.js         cron endpoint (§6)
    check-amazon-orders/route.js  cron endpoint (§6)
    check-cancellations/route.js  cron endpoint (§6)
    check-otc/route.js            cron endpoint (§6, §19)
    otc-config/route.js           GET/PATCH — OTC alert's Owner-vs-Broadcast scope setting (§19)
    otc-status/route.js           GET — today's OTC codes + window countdown; PATCH — Clear (display-only) (§19)
    packed-count/route.js         GET — today's Myntra packed-order count (added 2026-09-22, see note below)
    resolve-return/route.js       GET — resolve a Myntra return tracking id to SKU/size/photo, for stock-manager (§21)
    dashboard/resolve-return/route.js   GET — same resolver, admin_auth-gated + catalog-matched, for this app's own dashboard (§22)
    dashboard/add-return/route.js       POST — logs the resolved return into stock-manager (§22)
    admin/start|stop|check-now/route.js   dashboard action endpoints (§7)
    login/route.js                POST {username,password} -> creates a session, sets admin_auth (§23)
    logout/route.js               POST -> destroys the session, clears admin_auth (§23)
    accounts/route.js             GET/POST — list/create dashboard accounts, Owner-only (§23)
    accounts/[username]/route.js  DELETE — remove a dashboard account, Owner-only (§23)
    session/route.js              saves a freshly-pasted Myntra/Amazon session
    session/sync/route.js         same save, from the browser extension instead of a paste (§18)
    status/route.js               feeds the dashboard's status panel
    orders/route.js               feeds the dashboard's order grid (live-fetches both marketplaces + stock, doesn't read seenOrders — this is a live view, not the alert pipeline)
    recipients/route.js                    GET — list recipients (§20)
    recipients/[chatId]/route.js            PATCH/DELETE — change role / remove, password-gated (§20)
    recipients/refresh/route.js             POST — re-pull names live from Telegram (§20)
    recipients/history/route.js             GET — role-change history (§20)
scripts/
  seed-recipients.js         one-off: migrated the 3 hardcoded people into `recipients` at their existing effective roles (§20)
  protect-primary-owner.js   one-off: marked Gaurav's row `protected: true` (§20)
browser-extension/         Manifest V3 Chrome extension — auto-syncs the session (§18); not part of the Vercel deploy, lives in the user's Chrome
```

## 14. "Does this work when the site/laptop is closed?" — yes, in full

- The checking logic runs on **Vercel's servers**, not in your browser. Closing the dashboard
  tab, closing your laptop, anything client-side — none of it matters.
- An external always-on scheduler (**cron-job.org**) pings the three `/api/check-*` endpoints
  every ~1/~1/~30 minutes, 24/7, independent of anyone having the site open.
- Each ping is a no-op unless `running: true` (§6) — this is the one thing that actually gates
  alerts, and it's controlled by Start/Stop on the dashboard, not by the dashboard being open.
- When a marketplace session expires, checks fail (401/403) and nothing gets marked "seen" for
  that window. **The moment a fresh session is pasted, the very next check succeeds and treats
  every order still in the marketplace's "open" list as new** — so you get one alert per order
  that arrived during the outage, all at once. Caveat: only the most recent ~15 open orders per
  platform are ever fetched per call (`fetchSize=15` / `limit=15`), so a very long outage with a
  big backlog could miss the oldest ones — check manually if that's a risk.

## 15. Runbook: cleaning out state (Ready to Ship + seen-orders)

This has come up repeatedly during testing/debugging. The **only safe procedure**:

1. **Never write directly to stock-manager's `pendingshipments` collection** (even though
   `STOCK_MONGODB_URI` gives read access to it) — that would desync `SkuStock.reserved`. Only
   read it to get `_id`s, then cancel each one via `DELETE {STOCK_MANAGER_URL}/api/pending/<id>`
   (stock-manager's own `cancelPending`, which correctly releases the reservation).
   - To exclude specific orders (e.g. manually-added ones) from a bulk cleanup, filter the list
     by `orderId` before deleting.
2. Clear this app's own de-dup ledgers directly (safe — this is this app's own primitive state,
   not a reservation system): `db.collection('seenOrders').deleteMany({})` and
   `seenAmazonOrders.deleteMany({})`. Doing this makes every currently-open order look "new"
   again on the next check.
3. If you don't want that next check to actually fire yet, make sure
   `settings/_id:'status'.running` is `false` first (or call `POST /api/admin/stop`) — otherwise
   the very next cron tick (within ~1 minute) will immediately re-alert and re-queue everything
   currently open, since step 2 just made all of it look new.
4. Verify: re-query `pendingshipments` (should show only whatever you intentionally kept) and
   confirm `seenOrders`/`seenAmazonOrders` counts are 0.

## 16. Deployment workflow

1. Test the specific lib function locally first — read `.env.local` in a small Node script,
   `require('./lib/whatever')`, call it directly, inspect the output. Never guess.
2. `npm run build` — must succeed with zero errors before pushing.
3. `git add`, commit, `git push origin main` → `https://github.com/gauravbhandari23/bot.git`.
4. Vercel auto-deploys on push. Verify with
   `vercel ls bot --meta githubCommitSha=$(git rev-parse HEAD)` until it shows "Ready".
5. Spot-check the live behavior (curl an endpoint, or watch the next real alert) before
   considering the change done.
6. **`browser-extension/` is not part of this build/deploy at all** — it's loaded unpacked
   directly into Chrome (`chrome://extensions` → Developer mode → Load unpacked). Pushing to git
   does nothing for it; whoever's running it needs to click the reload icon (⟳) on the
   extension's card after a `browser-extension/` change lands.

## 17. Stack

Next.js 16 (App Router, Node runtime route handlers), React 19, native `mongodb` driver
(no ORM), `axios` for all outbound HTTP, deployed on Vercel. No test suite — verification is
always "run the real function against real data locally, then check the live behavior after
deploy."

## 18. Automatic session sync (`browser-extension/`)

Why this exists at all, and why it's built this way, is covered in §2 — short version: automated
*login* is blocked by Myntra's bot-detection (confirmed by testing, not assumed), but the orders
API itself accepts plain cookie replay just fine, so instead of automating login, a browser
extension automates *harvesting a session from a browser that's already logged in normally*.

**How it works:**
- A Manifest V3 Chrome extension (`background.js`, a service worker) uses the `cookies`
  permission to read Myntra (`*.myntrainfo.com`) and Amazon (`*.amazon.in`) cookies straight out
  of Chrome's cookie jar — critically, this can read **HttpOnly** cookies (`erp.at`, `erp.rt`,
  `session`), which a normal page script/bookmarklet cannot (verified via DevTools → Application →
  Cookies → HttpOnly column before building this — don't skip that check if extending this to
  another marketplace).
- It POSTs `{ marketplace, headers: { cookie, ...a few static headers, user-agent } }` to
  `POST /api/session/sync` with `x-sync-secret: EXTENSION_SYNC_SECRET`, which calls the same
  `lib/sessionStore.js#saveSession()` the admin page's manual paste uses (§7).
- `chrome.alarms` fires this every `SYNC_PERIOD_MINUTES` (currently 240 = 4h — Myntra's access
  token is ~3h but the *effective* session (via `session`/`erp.rt`) has been observed lasting up
  to ~24h in practice, so 4h is comfortable headroom either way).
- **Gotcha already hit and fixed**: naively recreating the alarm on every `chrome.runtime.
  onStartup` resets its countdown to full each time — meaning if the session died while Chrome
  was closed, reopening it wouldn't actually fix anything for up to another full period. Fixed by
  only recreating the alarm if it's missing or its period changed in code, and letting
  `chrome.alarms`' own native persistence handle the rest: a restart fires the alarm right away
  if its scheduled time already passed while Chrome was closed (session was overdue → syncs
  immediately), or simply keeps counting down to its original time if it hadn't (an
  in-progress countdown survives a restart untouched). `onStartup` deliberately does **not**
  force a sync itself — doing so would cut a still-valid countdown short instead of letting it
  finish.
- **Stop/Start** (popup buttons) toggles `chrome.storage.local.autoSyncEnabled` and
  clears/recreates the alarm — lets you pause the timer without uninstalling. The manual
  "Sync now" button always works regardless of this flag.
- The popup shows a live countdown to the next sync (recomputed from the alarm's
  `scheduledTime` every second while open, not a decrementing counter, so it can't drift) and a
  colored status dot per marketplace from the last sync result (`chrome.storage.local.lastResult`).

**Multi-device**: each install runs fully independently — its own alarm, its own schedule, no
coordination. Running it on 2+ devices is a deliberate, supported way to get redundancy (whichever
syncs most recently just becomes the current session; no conflict). Stopping/removing it on one
device doesn't affect any other.

**Amazon-specific header realism (added 2026-09-20)**: unlike Myntra, Amazon's replayed session
now gets a fuller, more browser-shaped header set — `accept-language`, `origin`/`referer`,
`sec-fetch-site`/`sec-fetch-mode`/`sec-fetch-dest`, and `sec-ch-ua`/`sec-ch-ua-mobile`/
`sec-ch-ua-platform` built fresh from this browser's own `navigator.userAgentData` at sync time
(`chromeClientHints()` in `background.js`). See §12 for why: this account's Amazon session was
lasting only ~12h (down from the usual 3-4 days) since this extension started sending a much
barer header set than a manually-pasted session ever had.

**Scheduled heartbeat (added 2026-09-20)**: the `chrome.alarms.onAlarm` handler now tells
`runAutoSync()` whether THIS firing was the main `SYNC_ALARM` (`scheduled: true`) or a
per-marketplace backoff retry (`scheduled: false`, the default everywhere else — installs,
`online` reconnects, the Start button). That flag rides along in the POST body to
`/api/session/sync`, and only `trigger: 'auto'` + `scheduled: true` + a verified-working sync
gets `lib/sessionStore.js#announceScheduledSyncOk()`'s quiet, Owner-only Telegram ping (§20) — a
backoff retry (which can fire every 1-15 minutes during a real outage) never does, which is what
keeps this from becoming the same activated/expired spam loop a similar announcement caused
before (§12).

**What it can't do**: refresh a session if you're actually logged out of Myntra/Amazon in that
browser (nothing to read — it errors clearly rather than sending garbage) — that still needs one
real, manual login, same as day one. It also can't be triggered remotely (e.g. from a Telegram
command) — the server has no channel to reach into a specific browser's cookie jar; only the
browser can push cookies out, nothing can pull them in from outside.

Full end-user setup steps live in `browser-extension/README.md`, not duplicated here.

## 19. Pickup/return OTC alert (`lib/checkOtc.js`, added 2026-09-22)

Myntra's warehouse pickup/return system issues a one-time code (OTC) the courier (MYS or MYE)
needs to hand over when they physically arrive to either collect outgoing parcels (`trip=PICKUP`)
or drop off returns (`trip=RETURN`) — `GET partnersapi.myntrainfo.com/api/location/otc?warehouse=
<id>&trip=<PICKUP|RETURN>` (`fetchOtc()` in `lib/myntra.js`). It reads `null` until a tripsheet
actually goes active for that courier.

- **Window**: only does anything between **12:00-13:00 IST** — checked in-process
  (`withinWindow()`), not just relied on from the cron-job.org schedule, so a stray or
  misconfigured trigger outside that hour is always a safe, instant no-op (no DB touch, no Myntra
  API call). The suggested cron-job.org schedule is every ~5 min, all day — see §6.
- **What one check does**: fetches both trip types for both couriers (4 values total: Pickup MYS,
  Pickup MYE, Return MYS, Return MYE) in one pass.
- **Alert + stop**: the moment any of those 4 is no longer `null`, sends **one** Telegram message
  with all 4 lines (blank/`—` for whichever are still null) — not silent. Then writes
  `settings/_id:'otc_status'.alertedDate` = today's IST date, which makes every later check that
  same day return `{ skipped: true, reason: 'already alerted today' }` immediately — no repeat
  pings, no more Myntra API calls for the rest of the hour.
- **Recipient scope, dashboard-configurable (added 2026-09-22, `lib/otcConfig.js`)**: a single
  global setting, `settings/_id:'otc_config'.recipientScope`, either `'OWNER'` (default — only
  Owner role gets this alert) or `'BROADCAST'` (everyone in the recipients list, Owner included —
  Owner always gets every alert regardless of this setting). Toggled from two buttons right on the
  "Alert recipients" dashboard card (`GET`/`PATCH /api/otc-config`, admin-login gated only — not
  the `ROLE_CHANGE_PASSWORD`, since this isn't a per-person permission change, just an alert-routing
  preference). Deliberately does **not** affect the session-problem alerts below — those always
  stay Owner-only, since a dead session isn't something a Viewer can act on.
- **Resets naturally the next day**: `alertedDate` is compared against *today's* IST date, so
  there's nothing to clear manually — tomorrow's first check in the window just won't match and
  proceeds normally.
- Uses the same Myntra session (`settings/_id:'session'`) as the order/cancellation checks — no
  separate session of its own.
- **Session-problem alerting (fixed 2026-09-22, review finding)**: the first version of this
  silently swallowed a missing-or-expired Myntra session during the window — `fetchOtc()`'s error
  just propagated to the cron route's JSON error response with nobody notified, exactly the hour
  the code is time-sensitive. Now `alertOtcSessionProblem()` sends one Owner alert (missing
  session, or a 401/403 from `fetchOtc`) per IST day — its own `errorAlertedDate` dedup flag on
  the same `otc_status` doc, independent of the success-side `alertedDate` so a session fixed
  mid-window still alerts normally the moment a real code appears.
- **Dashboard card (added 2026-09-22, `getOtcDisplayStatus()`/`clearOtcDisplay()` in
  `lib/checkOtc.js`, `GET`/`PATCH /api/otc-status`)**: a 6th stat-grid tile on the admin page shows
  whichever codes were found today (blank slots omitted), or — when nothing's been found yet — the
  window's live state: `windowActive` + `minutesToWindowChange` (minutes until 13:00 if currently
  in the window, minutes until the next 12:00 — today or tomorrow — otherwise), pure clock math,
  no DB. A **"Clear"** button next to a found code sets `clearedDate` = today's IST date, which
  hides that value from the card — but **deliberately never touches `alertedDate`**, so clearing
  the display can never make the poller start calling the Myntra API again for the rest of the
  day (verified directly against production: simulated a found-today state, cleared it, confirmed
  `runCheckOtc()` still reports already-alerted/skipped). Resets naturally the next day, same
  pattern as every other date-keyed field here.

## 20. Alert recipients — Owner/Viewer/None roles (`lib/recipients.js`, added 2026-09-22)

Replaces the old `TELEGRAM_CHAT_ID` (broadcast list) / `TELEGRAM_COMMAND_CHAT_ID` (single admin)
env vars with a real, dashboard-managed system backed by two collections (§5): `recipients` and
`recipientRoleHistory`. This also unifies **bot command access** (`/ship`, `/make`, ... —
`app/api/telegram-webhook/route.js`) onto the same Owner role, which used to be a separate,
unrelated check against `TELEGRAM_COMMAND_CHAT_ID`.

**Roles:**
- **OWNER** — receives every alert (broadcast + owner-only, see below) and can issue bot commands.
- **VIEWER** — receives broadcast alerts only (new orders, cancellations). Cannot issue commands.
- **NONE** — the default for a brand-new sender; receives nothing.

**Alert routing** (`lib/telegram.js`):
- `getBroadcastChatIds()` = `chatIdsForRoles(['OWNER','VIEWER'])` — used by default whenever
  `sendTelegramMessage`/`sendTelegramPhoto`/`sendTelegramMediaGroup` are called with no explicit
  chat id list (new-order and cancellation alerts).
- `sendOwnerAlert()` = sends to `chatIdsForRoles(['OWNER'])` only — replaces every old
  `replyToChat(process.env.TELEGRAM_COMMAND_CHAT_ID, ...)` call site: session-expired/missing
  (`checkOrders.js`, `checkAmazonOrders.js`), unresolved-cancellation (`checkCancellations.js`),
  session-activated/scheduled-sync-ok heartbeats (`sessionStore.js`), the extension-stale watchdog
  (`sessionSyncWatchdog.js`), and the OTC alert (§19).
- `replyToChat(chatId, ...)` (unchanged) still replies to one *specific* chat — used for bot
  command responses and the webhook's one-time welcome message, never role-routed.

**How someone gets into the list at all**: `app/api/telegram-webhook/route.js` calls
`recordSeen(chatId, {name, username})` on **every** incoming message, from anyone — not just an
existing Owner. First time a chat id is ever seen: inserted at role `NONE`, and the bot replies
once with a short "noted, ask Gaurav to activate you" message. Every time after (including from
an existing Owner/Viewer): just refreshes `name`/`username`/`lastSeenAt` from that message — this
is what keeps a recipient's displayed name "live from Telegram" for anyone actively messaging,
without needing a manual sync. `recordSeen()` also returns the chat's current `role`, which the
webhook uses immediately to decide command access (no extra DB round-trip).

**Command access** (`app/api/telegram-webhook/route.js`): after `recordSeen()`, `isOwner = role
=== 'OWNER'`; if not, the message is silently ignored from that point on (never reveals the bot
understands commands) — same shape as the old hardcoded check, just role-driven instead of a
fixed env var.

**Protected founding Owner**: Gaurav's seeded row has `protected: true` (set once via
`scripts/protect-primary-owner.js`). `setRole()`/`deleteRecipient()` both refuse outright on a
protected row (`"...protected and cannot be changed/removed here"`), and `GET /api/recipients` /
`POST /api/recipients/refresh` both filter protected rows out of what the dashboard ever sees —
so there is no way, through this UI, to demote or remove yourself and lock everyone out. A
protected row keeps full Owner power underneath (alerts + commands) regardless — the flag only
blocks *editing* it through the API, nothing else.

**Password-gated role changes**: `PATCH /api/recipients/[chatId]` (change role) and
`DELETE /api/recipients/[chatId]` (remove) both require a `password` field in the request body,
checked server-side against `ROLE_CHANGE_PASSWORD` (§4) — a second, deliberate confirmation on
top of the dashboard's own login, since these control who gets alerted about real orders/returns.
The dashboard prompts for it via `window.prompt()` on every action (never cached/remembered).
**`ROLE_CHANGE_PASSWORD` must be set in Vercel's project environment variables** (added to
`.env.local` locally on 2026-09-22) — until it is, every role change/removal on the deployed site
fails closed with "Wrong password," which is the safe direction for that to fail in.

**Role-change history**: every actual role transition (no-op if clicking the already-active
button) is logged to `recipientRoleHistory` — `{chatId, name, fromRole, toRole, changedAt}` — shown
in the dashboard's "Role change history" section. `deleteRecipient()` never touches this
collection, so a removed recipient's history stays visible forever, by design.

**"Refresh" button** (`POST /api/recipients/refresh`): re-pulls every *visible* (non-protected)
recipient's current name/username straight from Telegram's `getChat` API
(`getChatInfo()` in `lib/telegram.js`) and overwrites it in the DB — guarantees names are
verifiably Telegram-sourced on demand, not just whatever was captured the last time that person
happened to message the bot.

**Migration (2026-09-22, already run against production)**: `scripts/seed-recipients.js` inserted
the 3 previously-hardcoded people (Gaurav → OWNER, Mukesh Bhandari → VIEWER, Alka Bhandari →
VIEWER) at the roles they already effectively had, so alert delivery didn't change during deploy.
`scripts/protect-primary-owner.js` then marked Gaurav's row `protected: true`. Both are idempotent
one-offs (`--dry` flag supported) — safe to re-run, they no-op on anything already in the expected
state.

## 21. Resolve a Myntra return tracking id (`GET /api/resolve-return`, added 2026-09-22)

Grading a Myntra return in stock-manager used to mean two manual lookups on Myntra's own site:
search the return tracking id (e.g. `MYSR...`) in the Seller Protection Fund claims panel to get
the *original* shipment tracking id + a product photo, then search *that* id again in the
packed-orders search to get the real seller SKU + size. This endpoint does both automatically,
server-to-server, so stock-manager's Returns page can do it in one call.

- **`resolveReturnByTrackingId(returnTrackingId, headers)`** (`lib/myntra.js`) chains two Myntra
  calls and **always returns an array**:
  1. `fetchSpfClaims()` — `GET .../api/spf/fetchNewClaim?fetchAccio=true&id=<returnTrackingId>` —
     gives back the *original* outbound tracking id (`trackingId`, a different number, e.g.
     `MYSP...`) and one product photo (`styleInfo.imageLink`, upgraded to `https://`) per claim —
     deliberately the **only** image used; the richer multi-angle image set from step 2 is ignored
     on purpose (asked for specifically — SPF's own photo is what should show).
  2. `fetchPackedOrderByTracking()` — `GET .../api/mdirect/orders/searchPostPackedOrder/<warehouse>
     ?searchOn=trackingNumber&id=<originalTrackingId>` — gives back **every** `lineItems[]` entry
     on that shipment (real `sellerSkuCode`, e.g. `RRC-012-CO-HI-GRN-M`, exactly stock-manager's
     own SKU format, plus `.size`/`.color`).
  - **Fixed same day, real case (multi-item shipment)**: the first version took `data[0]` from
    both calls, silently dropping every item but the first. Confirmed for real: one shipment
    (`MYEP1132530153`) carrying 2 different products returns 2 separate SPF claims, each with its
    own `skuId`/`styleInfo`/image, sharing that one tracking id — and its packed-order record is
    ONE order with a 2-entry `lineItems[]`, not two separate order records. Now every claim is
    kept, and each is matched to its own line item **by `skuId`** (never by array position) —
    verified against this exact real order: correctly resolved to two distinct SKUs
    (`RRC-011-CO-F-BLU-M` / Blue and `RRC-011-CO-J-GRN-M` / Green), each with its own photo. A
    single-item return still just comes back as a 1-element array, so callers never special-case
    the common case.
  - Returns `[]` only if step 1 finds no claim at all. A claim found but with no resolvable SKU
    still gets an entry (image/`returnReason`/`returnMode` intact) with `sku`/`size`/`color` left
    `null`, so the caller can say exactly what's missing rather than silently dropping it.
  - Verified directly against production with real tracking ids, both single- and multi-item —
    matched the exact payloads captured from DevTools before this was built.
- **The route** (`app/api/resolve-return/route.js`) is the **one exception** to this integration's
  usual direction — every other call between these two apps goes bot → stock-manager (§8); this
  one goes stock-manager → bot. Guarded by `RESOLVE_RETURN_SECRET` in an `x-resolve-secret`
  header (never a query param, so it's never logged in a URL) — same convention as the browser
  extension's `EXTENSION_SYNC_SECRET`/`x-sync-secret` (§18), just a different secret for a
  different caller. Response shape: `{ items: [...] }`, one or more resolved items, only the ones
  with a resolvable SKU. Responds 404 (not 500) both when no claim is found at all and when no
  item on it has a resolvable SKU — both are "nothing to add," not server errors.
- **What happens on the other end**: stock-manager calls this, shows the photo/SKU/size, and logs
  the actual return itself using its own existing return-logging code — this endpoint only
  resolves data, it never writes anything. See stock-manager's own `PROJECT.md` for that side.

## 22. Scan a Myntra return, straight from this dashboard (added 2026-09-22)

The whole return-resolve-and-log flow (§21) is also usable **without opening stock-manager at
all** — this app can both resolve AND write, since it already has a live Myntra session (for
resolving) and `STOCK_MANAGER_AUTH_TOKEN` (for writing, same as `addToReadyToShip()` already
uses). "Scan a Myntra return" is a card on the dashboard itself, open by default.

- **`GET /api/dashboard/resolve-return?trackingId=...`** — the dashboard's own version of §21's
  resolver: same `resolveReturnByTrackingId()`, but gated by the normal `admin_auth` login
  (`isAuthed()`) instead of `x-resolve-secret` (that header is for stock-manager's server-to-server
  call specifically — this route is for the browser, logged into this app). Additionally matches
  each item's resolved SKU against stock-manager's own product catalog via a new
  **`lookupProductBySku(sku)`** in `lib/stock.js` (same `STOCK_MONGODB_URI` read-only connection
  this app already uses for stock lookups) — exact match first, then suffix fallback (same
  brand-prefix-drift tolerance as `skuSuffix`/stock-manager's own `stockSkuFor`/`addPending`).
  Response: `{ candidates: [...] }`, one entry per resolved item (always a list, multi-item
  shipments included — same fix as §21), each with `matchedSku`/`productName` (null + a
  `matchError` string if nothing in the catalog matched).
- **`POST /api/dashboard/add-return { sku, qty, trackingId, condition }`** — `lib/returns.js`'s
  **`addReturnToStockManager()`** posts straight to stock-manager's `POST /api/register`
  (`action: 'RETURN'`, `channel: 'MYNTRA'`), the *exact same write path* stock-manager's own
  Returns page uses — this app never touches stock-manager's database directly, only its API,
  same rule `addToReadyToShip()` already follows for the Ready-to-Ship queue.
- **UI**: one card per candidate — photo, resolved product, a bold accent-colored "Size: X" badge
  (deliberately more visually prominent than the rest of the card's plain text, so it's the one
  thing a packer can't miss at a glance), color/return reason, a condition dropdown
  (`GOOD`/`USED`/`FAKED`/`WRONG`/`DEFECTIVE` — duplicated here as a small constant since this app
  never imports stock-manager's own `RETURN_CONDITIONS`, same boundary as `BUNDLE_CODE_MAP`) and
  an "Add to Return" button per item; a saved item is marked "✓ Added" without clearing the rest of
  the list, so a multi-item shipment can be added one at a time off a single scan, same UX as
  stock-manager's own version of this feature. The card sits above "Open orders" (moved there so
  it's the first thing visible on open). The candidate photo renders at its natural aspect ratio
  (`objectFit: 'contain'`, width capped ~170px/38vw, height capped ~250px) rather than a cropped
  square — an earlier `objectFit: 'cover'` square was cutting off parts of the product photo.
- **Camera scan**: `components/BarcodeScanner.js` — a plain-JS/JSX port of stock-manager's own
  `BarcodeScanner.tsx` (this app has no TypeScript), same `@zxing/browser` approach: full-screen
  overlay, rear camera preferred automatically, continuous decode until a code is found or
  cancelled, media stream explicitly stopped on unmount. `playsInline` on the `<video>` is required
  for iOS Safari specifically, or it forces its own native fullscreen player instead. Tuned for
  speed/reliability (2026-09-22): the default `delayBetweenScanAttempts` is 500ms (~2 decode
  attempts/sec, the main source of felt lag) — dropped to 75ms (~13/sec). `DecodeHintType.
  POSSIBLE_FORMATS` restricts decoding to the 1D formats tracking/label barcodes actually use
  (CODE_128/CODE_39/EAN_13/EAN_8/UPC_A/ITF) instead of zxing trying every symbology it knows on
  every frame, and `TRY_HARDER` is on to still catch slightly blurry/tilted codes. Camera opened
  via `decodeFromConstraints()` (not `decodeFromVideoDevice()`) with explicit `{ width: 1280,
  height: 720, advanced: [{ focusMode: 'continuous' }] }` instead of the browser's default
  resolution/focus. `@zxing/library` (a peer dep of `@zxing/browser`, previously only resolved
  transitively) was added as a direct dependency since these hint types are imported from it
  directly.
- **Verified end-to-end against production**: both the single-item (`MYSR1249196910`) and the real
  2-item (`MYEP1132530153`) cases resolve through the FULL chain — SPF claim, packed-order line
  items, and the catalog match — to the correct, already-confirmed SKUs. The write side reuses
  stock-manager's own `/api/register`, the exact same code path already exercised by its own
  Returns page scan feature.
- **stock-manager gotcha (fixed 2026-09-22)**: this feature's `POST /api/register` call
  initially 502'd with `{"error":"Unauthorized"}` — stock-manager's `proxy.ts` service-token
  bypass (the same `STOCK_MANAGER_AUTH_TOKEN` this app already uses for `/api/pending`, §10) only
  allowlisted the `/api/pending` prefix, so this app's genuinely-correct service token fell
  through to the real-session lookup, found none, and 401'd. Fixed on stock-manager's side by
  adding `/api/register` to its `SERVICE_API_PREFIXES` — see stock-manager's own `PROJECT.md`.

## 23. Dashboard login accounts — Owner/Viewer roles (`lib/accounts.js`, added 2026-09-22)

Replaces the single shared `ADMIN_PASSWORD` env var (one password, everyone who had it was
equally "logged in") with real per-person accounts and a role — same idea as stock-manager's own
account system, simplified to two roles for now (no Manager here).

- **`accounts` collection** (`lib/accounts.js`) — `_id` is the lowercased username. `createAccount`,
  `listAccounts` (passwords never included), `verifyPassword`, `deleteAccount`. Passwords hashed
  with Node's built-in `scrypt` (no new dependency); `verifyPassword` always does exactly one
  `scryptSync` call, real account or not (`DUMMY_SALT` stands in for a nonexistent username) —
  closes the same timing side-channel stock-manager's own login already closes, response time
  alone can't reveal which usernames are real.
- **`protected: true`** marks the one seeded, founding Owner (`gaurav`) — `deleteAccount()` refuses
  it outright, and separately refuses removing the last remaining Owner even if unprotected, so
  this UI can never lock every Owner out of itself. Exact same pattern as the Telegram recipients
  list's own founding-Owner protection (§20).
- **Sessions**: `lib/adminAuth.js` was rewritten around a new `sessions` collection instead of the
  cookie literally holding the shared password — `admin_auth` cookie now holds a random session
  token (`crypto.randomBytes(32)`, 30-day expiry, same as the old cookie's `maxAge`). Every
  existing `isAuthed()` call site across the app (17 routes) needed **no changes** — the function
  still just returns a boolean; only its internals and `app/api/login/route.js` changed. Added
  `getCurrentAccount()` (returns `{username, role}` or `null`) for routes that need to know who,
  not just whether.
- **`POST /api/login { username, password }`** replaces the old `{ password }`-only route.
  **`POST /api/logout`** (new) destroys the session server-side and clears the cookie.
  **`GET /api/status`** now also returns `account: {username, role}` so the dashboard knows who's
  logged in without a separate round trip — it was already the bootstrap "am I logged in" call.
- **`GET/POST /api/accounts`, `DELETE /api/accounts/[username]`** (new, Owner-only) — list, create,
  remove dashboard accounts. New accounts default to Viewer in the UI but Owner can pick either
  role.
- **UI**: login form gained a Username field. Header shows `username · Owner`/`Viewer` + a Log out
  button. A new "Dashboard team" card (Owner-only — hidden entirely for a Viewer, styled like the
  existing Alert recipients card, reusing its `.recipient-row`/`.role-btn`/`.remove-btn` classes)
  lists accounts and lets an Owner add one (username, password ≥8 chars, role) or remove one.
- **Scope, deliberately (asked for "just this first")**: this ships the account/role system and
  the Team management UI. It does **not** yet gate individual dashboard actions differently by
  role (Start/Stop, Check now, Refresh Myntra session, Add to Return, Recipients, etc. all still
  work the same for both roles once logged in) — only the Team card itself is Owner-only so far.
  Narrowing what a Viewer can actually *do* on the rest of the dashboard is a deliberately separate
  follow-up, not assumed here.
- **Seeded via `scripts/seed-dashboard-owner.js`** (one-off, run once): creates `gaurav` as the
  protected founding Owner. Verified live: login (correct password, wrong password, unknown
  username), account creation, the protected/last-Owner delete refusals, and cleanup all behaved
  correctly against production before this shipped.
