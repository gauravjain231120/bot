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
                                                       │
                                                       ├──► Telegram (order/cancel alerts)
                                                       │
                                                       └──► its own MongoDB (session, status,
                                                            seenOrders, seenAmazonOrders,
                                                            seenCancellations)
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
| `TELEGRAM_CHAT_ID` | Comma-separated list of chat IDs that receive every broadcast alert (new orders, cancellations — both Myntra and Amazon, no per-marketplace filtering) |
| `TELEGRAM_COMMAND_CHAT_ID` | The **admin** chat — replies to bot commands (`/ship`, `/make`, etc.) and primary-only alerts (session expiry, order-add failures) go here only, not to the full broadcast list |
| `WAREHOUSE_ID` | Myntra warehouse ID used in its API URLs (default `89623` if unset) |
| `ADMIN_PASSWORD` | Password for the dashboard login; also the literal value stored in the `admin_auth` cookie |
| `CRON_SECRET` | Shared secret cron-job.org must pass as `?secret=` on every check endpoint |
| `EXTENSION_SYNC_SECRET` | Shared secret the browser extension sends as `x-sync-secret` on `POST /api/session/sync` (§18) |
| `MONGODB_URI` | This app's own MongoDB Atlas connection string |
| `MONGODB_DB` | This app's own DB name (defaults to `myntra_alerts`) |
| `STOCK_MONGODB_URI` | **Read-only** connection to stock-manager's MongoDB, for live stock lookups |
| `STOCK_MANAGER_URL` | Base URL of the stock-manager deployment (defaults to `https://stock-manager-niko.vercel.app`) |
| `STOCK_MANAGER_AUTH_TOKEN` | Sent as `Cookie: auth=<token>` on every call to stock-manager's `/api/pending*` — must equal whatever stock-manager's own login sets as that cookie's value |

### Telegram recipients (current `.env.local`)

| Chat ID | Name | Role |
|---|---|---|
| `5349388385` | Gaurav | **Admin** — set as `TELEGRAM_COMMAND_CHAT_ID`, also included in `TELEGRAM_CHAT_ID` so they get broadcasts too |
| `8811057878` | Mukesh Bhandari | Broadcast-only |
| `8850201003` | Alka Bhandari | Broadcast-only |

**Rule:** Gaurav's chat ID is the one and only admin (`TELEGRAM_COMMAND_CHAT_ID`). Any chat ID added to `TELEGRAM_CHAT_ID` in the future is broadcast-only by default — it will receive every new-order/cancellation alert (Myntra + Amazon) but will never receive command replies or primary-only alerts unless it is explicitly also set as `TELEGRAM_COMMAND_CHAT_ID`. Do not repurpose `TELEGRAM_COMMAND_CHAT_ID` to hold multiple IDs — it must stay a single chat ID.

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
- `seenOrders` — `{ _id: orderId, seenAt }` — every Myntra order ID the poller has ever fetched (whether or not it turned into an alert). This is the de-dup ledger; an order ID here is never alerted again.
- `seenAmazonOrders` — same, for Amazon (`_id: amazonOrderId`)
- `seenCancellations` — same idea, for Myntra cancelled-order IDs

**"New" is defined purely as "order ID not yet in `seenOrders`/`seenAmazonOrders`."** Nothing
here tracks whether the underlying order is later shipped, cancelled, edited, etc. — that state
lives entirely in stock-manager's Ready to Ship queue.

## 6. The three cron endpoints

| Endpoint | Suggested frequency | What it does |
|---|---|---|
| `GET /api/check-orders?secret=CRON_SECRET` | ~1 min | Poll Myntra open orders, alert + queue new ones |
| `GET /api/check-amazon-orders?secret=CRON_SECRET` | ~1 min | Poll Amazon unshipped orders, alert + queue new ones |
| `GET /api/check-cancellations?secret=CRON_SECRET` | ~30 min | Poll Myntra cancellations, alert on new ones |

All three:
1. Reject with 401 if `?secret=` doesn't match `CRON_SECRET`.
2. Read `settings/_id:'status'.running` — **if false, return `{ skipped: true, reason: 'stopped' }` immediately and do nothing else.** This is why "Stop" reliably silences everything even though the external scheduler keeps ticking every minute regardless.
3. If running, fetch from the marketplace, diff against the seen-collection, alert + queue anything new, then mark everything fetched as seen (including things that weren't "new" — a session that expired and got refreshed won't re-alert stale orders it already knew about before the outage... but *will* alert orders it never got the chance to see. See §14.)
4. On a 401/403 from the marketplace (session expired), sends exactly one Telegram warning (guarded by the `sessionExpiredAlertSent`/`amazonSessionExpiredAlertSent` flag so it doesn't repeat every minute) and records the error for the dashboard.

`check-cancellations` has one extra rule: **on its very first-ever run** (empty `seenCancellations`
collection), it seeds silently instead of blasting a cancellation alert for the entire historical
backlog.

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
- Some product codes are **bundles** that draw stock from a *different* product's pool (e.g.
  "Halter with Palazzos" physically ships as a "Halter Neck" top). `BUNDLE_CODE_MAP` in this
  file (`{'012':'002', '013':'001'}`) mirrors stock-manager's own `BUNDLE_STOCK_PREFIX` constant
  — **this is intentionally duplicated, not imported**, because this app was built to never
  import or directly touch stock-manager's codebase. **If stock-manager's bundle mapping ever
  changes, this map must be updated by hand.**
- Stock classification: `available = onHand - reserved`; `available <= 0` → "OUT OF STOCK"
  (red), `<= 5` → "Low (N left)" (yellow), else → "N available".
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

## 13. File map

```
lib/
  db.js                 this app's own Mongo connection (cached across warm serverless invocations)
  stock.js              read-only stock lookup against stock-manager's DB (§9)
  readyToShip.js         writes to stock-manager's Ready to Ship queue via its HTTP API (§10)
  dates.js               IST formatting + the Myntra ship-by cutoff rule (§12)
  curl.js                 parses pasted cURL / DevTools header-dump text into a headers object
  telegram.js             the only file that calls the Telegram Bot API
  adminAuth.js            checks the `admin_auth` cookie against ADMIN_PASSWORD
  monitorState.js         getRunning/setRunning on settings/_id:'status'.running
  myntra.js                Myntra API calls + per-order/per-item Telegram text formatting
  amazon.js                Amazon API calls + per-order/per-item Telegram text formatting
  checkOrders.js           orchestrates one Myntra poll cycle (fetch → diff → alert → queue)
  checkAmazonOrders.js     same, for Amazon
  checkCancellations.js    orchestrates the Myntra-cancellations poll cycle
  pendingQueue.js          removes cancelled orders/lines from stock-manager's queue, or un-ships them if already shipped, via its HTTP API (§12)
  sessionSyncWatchdog.js   alerts if an extension-sourced session goes stale (§12, §18)
  sessionStore.js          shared save-a-session logic (§18) — used by both session routes below
app/
  page.js                  the dashboard (login form + admin UI + order grid)
  globals.css              all dashboard styling, theme (light/dark) CSS variables
  api/
    check-orders/route.js         cron endpoint (§6)
    check-amazon-orders/route.js  cron endpoint (§6)
    check-cancellations/route.js  cron endpoint (§6)
    admin/start|stop|check-now/route.js   dashboard action endpoints (§7)
    login/route.js                sets the admin_auth cookie
    session/route.js              saves a freshly-pasted Myntra/Amazon session
    session/sync/route.js         same save, from the browser extension instead of a paste (§18)
    status/route.js               feeds the dashboard's status panel
    orders/route.js               feeds the dashboard's order grid (live-fetches both marketplaces + stock, doesn't read seenOrders — this is a live view, not the alert pipeline)
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
gets `lib/sessionStore.js#announceScheduledSyncOk()`'s quiet, Gaurav-only Telegram ping — a
backoff retry (which can fire every 1-15 minutes during a real outage) never does, which is what
keeps this from becoming the same activated/expired spam loop a similar announcement caused
before (§12).

**What it can't do**: refresh a session if you're actually logged out of Myntra/Amazon in that
browser (nothing to read — it errors clearly rather than sending garbage) — that still needs one
real, manual login, same as day one. It also can't be triggered remotely (e.g. from a Telegram
command) — the server has no channel to reach into a specific browser's cookie jar; only the
browser can push cookies out, nothing can pull them in from outside.

Full end-user setup steps live in `browser-extension/README.md`, not duplicated here.
