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
| `ROLE_CHANGE_PASSWORD` | Second password required (on top of being logged in) to change a recipient's role or remove them — §20 |
| `WAREHOUSE_ID` | Myntra warehouse ID used in its API URLs (default `89623` if unset) |
| ~~`ADMIN_PASSWORD`~~ | **No longer read anywhere in this codebase (as of 2026-09-22).** Dashboard login is now real per-account accounts in the `accounts` collection (§23), not one shared password — safe to remove from Vercel whenever |
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

## 7. Dashboard — multi-page shell (rewritten 2026-09-22, was a single `app/page.js`)

**Auth**: real per-account login (§23) — cookie `admin_auth` holds a random session token
(`lib/adminAuth.js`), not a shared password. `ADMIN_PASSWORD` is gone; ignore any doc or memory
that still mentions it.

**Structure**: the whole dashboard used to be one ~1,400-line `app/page.js`. It's now a real
multi-page app sharing one persistent sidebar/topbar shell and one pool of live state:

- **`lib/DashboardContext.js`** (`DashboardProvider` + `useDashboard()`) — owns auth/account/
  theme, `status`/`orders`/`otcConfig`/`otcStatus`/`packedCount`/`recipients`/`roleHistory`/
  `accounts` and their loaders, and the **single 60s poll loop** (`REFRESH_MS`). Mounted once in
  `app/layout.js`, so it survives client-side page navigation — switching pages never loses live
  data or re-triggers a fetch storm. Polling rules (unchanged from before the rewrite, still
  load-bearing for Active CPU cost): `loadStatus/loadOrders/loadOtcConfig/loadOtcStatus` fire
  every tick unconditionally, `loadRecipients/loadRoleHistory` only when `isOwner`, and
  `loadPackedCount`/`loadAccounts` are **excluded from the interval** entirely — each fetches once
  (on initial load, or an explicit action) and never on a timer.
- **`components/AppShell.js`** — the sidebar (nav links + active-route highlight) and topbar
  (Start/Stop, Check now, account chip, theme toggle, logout). Sidebar is `position: fixed`
  (**not** `sticky` — `sticky` on a flex item inside a `display:flex` container with a fixed
  `height` is a known cross-browser breaker, and that's exactly what this was; it visually
  scrolled away with the page instead of staying put, fixed 2026-09-22), full height, always on
  screen past 900px width; under 900px it's an off-canvas drawer (`transform: translateX(-100%)`
  ↔ `translateX(0)`, plus a click-to-close scrim), same technique stock-manager's own
  `Sidebar.tsx` uses. `.shell-main` is offset with `margin-left: 240px` to make room for it (0 on
  mobile, where the sidebar overlays instead of pushing content). The mobile hamburger button
  (`.nav-toggle`) is hidden whenever the drawer is already open — showing both it and the drawer's
  own close (✕) button at once was confusing (fixed 2026-09-22). Renders
  `components/LoginScreen.js` instead of the shell while `authed !== true` — same
  `null`(loading)/`false`(show login)/`true`(show shell) branching the old single page had.
  - **Hamburger/close visibility made JS-driven, not CSS-only (fixed again 2026-09-22, same day)**:
    the first fix above relied purely on a CSS media query to hide `.nav-toggle`/`.sidebar-close`
    above 900px — the user still saw both simultaneously on a wide screen afterward. Since the CSS
    is verifiably correct (re-checked directly), the mismatch is a browser/deploy caching
    explanation, not a code bug — but the fix is now robust either way: `AppShell.js` tracks
    `isMobile` itself via `window.matchMedia('(max-width: 900px)')` and only renders these buttons
    (and the scrim) at all when actually true, so there's no CSS-cascade/cache failure mode left
    to hide behind. Also resets `navOpen` back to `false` whenever the breakpoint is crossed (e.g.
    a window resized wider), so a stuck-open drawer/scrim can't survive that.
- **Design tokens rebuilt to match stock-manager's own (2026-09-22)** — `app/globals.css`'s
  `:root`/dark-mode color variables, previously an independently-chosen indigo palette, now copy
  stock-manager's actual values directly: brand maroon/dusty-rose accent (`#9c4458` light /
  a lighter `#c85f79` tint for dark-mode legibility — stock-manager itself never uses its brand
  color as plain text on a dark background, only as solid button fills, so this app needed a
  choice it didn't; same hue family either way), `emerald-600` for success (was a plain green),
  page background `#fafafa` light / `#000000` dark with card surface `#ffffff` / `#171717` (was a
  more tinted-gray/indigo-dark scheme), `12px` card radius + a single flat `shadow-sm`-style shadow
  (was a two-layer floatier one), `8px` button/nav-link radius. The sidebar's active-link state
  also changed from a soft accent-tinted background to a **solid** brand-color fill with white
  text — stock-manager's actual `Sidebar.tsx` pattern (`bg-brand-600 text-white shadow-sm`), not a
  softer style of this app's own invention.
- **Pages**, each pulling only what it needs from `useDashboard()` plus its own page-local state
  (forms, scan candidates, filters — anything that was never part of the poll loop):

  | Route | Content | Notes |
  |---|---|---|
  | `/` | Stat grid (7 cards) + Open orders grid | landing page; orders grid added 2026-09-22 so it's visible without a click — see `components/OrdersGrid.js` below |
  | `/orders` | Open orders grid + platform filter | same `OrdersGrid` component as `/`; no longer linked from the sidebar (removed 2026-09-22, redundant with `/` showing the same grid) but the route itself still exists |
  | `/returns` | **Myntra Return** — scan a Myntra return (§22) | camera scan, resolve, add to stock-manager; scanned-this-session list |
  | `/packed` | **Myntra Pack** — scan a Myntra packed/picked label (§25) | product, SKU, size, packed/pick-by/picked/shipped times |
  | `/amazon-packed` | **Amazon Pack** — scan an Amazon label by tracking or order ID (§26) | order + items + ship-by/pickup slot; order ID read by camera OCR |
  | `/amazon-returns` | **Amazon Return** — scan an Amazon return by tracking or order ID (§26) | add to stock-manager as channel AMAZON |
  | `/sessions` | Refresh Myntra/Amazon session forms | session *history* removed 2026-09-22, see below |
  | `/recipients` | Alert recipients (§20) + OTC scope toggle (§19) + role change history | **Owner-only** |
  | `/team` | Dashboard accounts CRUD + role changes, confirmation-password-gated (§23) | **Owner-only** |
  | `/spf-status` | SPF claim counts + paid ₹ total split into Fake / Wrong (§24) | **Owner-only** |

- **Form layout gotcha (fixed 2026-09-22, twice)**: the Team page's "add account" row was
  originally an inline `display:flex; flexWrap:wrap` style with unsized children — rendered as a
  narrow column pinned to the card's right edge instead of a row. First fix: a reusable
  `.form-grid`/`.field` CSS grid (`app/globals.css`). That alone didn't fix it — the *real* root
  cause was a specificity conflict with the pre-existing `.card form { display:flex;
  flex-direction:column }` rule (specificity `0,1,1`, beats `.form-grid`'s bare-class `0,1,0` on
  `display`/`gap`), while `.form-grid`'s *other* properties (`align-items:end`) still applied
  unopposed — that exact mix (flex-direction:column + align-items:end) is what produced the
  stacked-and-right-aligned look, not the grid itself failing. Fixed for real by scoping the old
  rule to `.card form:not(.form-grid)`. **Lesson, repeated from an earlier specificity bug this
  same session (the `button.secondary`/`.remove-btn` one) — check for a higher-specificity rule
  on the same element before concluding a new class's styles "aren't applying."**
  Use `.form-grid` for any future inline form like this one, not ad-hoc flex-wrap.
- **Session history removed entirely (2026-09-22)** — the user didn't want it. Removed: the
  "Session history" card, `lib/sessionHistory.js` (`recordSessionCaptured`/`recordSessionExpired`/
  `listSessionHistory`), `app/api/session-history/route.js`, the calls into it from
  `announceSessionActivated()` (`lib/sessionStore.js`) and both check loops'
  `alertSessionMissingOrExpired()` (`lib/checkOrders.js`/`lib/checkAmazonOrders.js`), and the
  `sessionHistory` MongoDB collection's data itself (151 documents deleted from production). This
  was purely an audit-trail side channel — it never drove any alerting/dedup logic (that's the
  separate `sessionExpiredAlertSent`/`amazonSessionExpiredAlertSent` flags on the `status` doc,
  untouched) — so removing it has zero effect on real session-expiry alerting.

  Owner-only pages check `isOwner` from context and render a plain "Owner only" notice for a
  Viewer — belt-and-braces on top of the APIs themselves already being Owner-gated server-side
  (`requireOwner()`), never the only guard.
- **`lib/format.js`** — `timeAgo`/`formatMinutes`/`otcLines`/`RETURN_CONDITIONS`/
  `RETURN_CONDITION_LABELS`, extracted so more than one page can use them without duplicating.
- **`components/icons.js`** — every inline SVG icon component, extracted the same way.

**Zero backend behavior change from this rewrite** — every `app/api/*` route, every `lib/*.js`
backend file, every cron/webhook endpoint is untouched. This was purely a frontend restructuring
(one page → sidebar + 7 pages sharing one context) done by moving existing state/effects/handlers
verbatim into their new homes, not rewriting their logic.

- **Start** (`POST /api/admin/start`) — sets `running: true`, then immediately runs both Myntra
  and Amazon checks synchronously (so it "catches up" right away instead of waiting up to a
  minute for the next cron tick).
- **Stop** (`POST /api/admin/stop`) — sets `running: false`. Cron ticks keep firing every minute
  but every one becomes a no-op.
- **Check now** (`POST /api/admin/check-now`) — runs both checks immediately, **regardless of
  the running flag** (does not check or change it). Useful for testing without toggling Start.
- **Refresh session** (Myntra/Amazon forms, now on `/sessions`) — paste a `curl` command or a raw
  DevTools "Headers" panel dump; `lib/curl.js` parses either format into a headers object (handles
  both `-H 'cookie: ...'` and `-b '...'` cookie styles, and both `-H` cURL flags and the two-line
  header-dump format). Strips `content-length`/`accept-encoding`/`connection` since those are
  meaningless when replayed from a server. Both this route (`app/api/session/route.js`) and the
  extension's sync route (`app/api/session/sync/route.js`, §18) call the same
  `lib/sessionStore.js`'s `saveSession()` to actually write it — same DB write, same
  "✅ session activated" confirmation either way, just a different capture method (and a
  different auth check: admin cookie here, a shared secret there). That confirmation is sent
  **silently** (`disable_notification`) on purpose, since with the extension running it's a
  routine every-few-hours all-clear, not something worth a buzz — unlike session-*expired*, which
  stays noisy.
- **Platform filter** (`/orders`) / **theme toggle** — pure display, no server effect.

**Deliberate exception, "Myntra packed today" stat card (added 2026-09-22)**: every other
dashboard stat is either DB-read (cheap, safe to poll every 60s) or already covered by the
cron checks. This one calls `/api/packed-count`, which hits Myntra's live `getPostPackedOrders`
API directly, on request. That call is made **once, only when the dashboard is opened** — it is
*not* in the poll interval (`loadPackedCount()` is called in `DashboardContext`'s mount effect
but left out of `setInterval`'s body, on purpose) — a manual "Refresh" button on the card is the
only other way to trigger it. Leaving the dashboard open must never cause a recurring background
Myntra call just because the interval ticked. (Briefly moved into the interval, then reverted the
same day — the user explicitly wants this manual-only, not real-time-polled.)

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
  (the dashboard's `/orders` page, `/api/orders`) is affected — they still show the real level/number.
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
  **Note (2026-09-22, later the same day)**: the `sessionHistory` collection this investigation's
  lifespan data came from has since been removed entirely (feature + data — the user didn't want
  it), so re-running this analysis later needs a different data source — there's no longer an
  audit trail of past session capture/expiry events to pull from.

## 13. File map

```
lib/
  db.js                 this app's own Mongo connection (cached across warm serverless invocations)
  stock.js              read-only stock lookup against stock-manager's DB (§9); lookupProductBySku() for §22, added 2026-09-22; lookupReturnsByTracking() (RETURNED rows' condition by tracking id) for §24's paid split, added 2026-09-23
  readyToShip.js         writes to stock-manager's Ready to Ship queue via its HTTP API (§10)
  dates.js               IST formatting + the Myntra ship-by cutoff rule (§12)
  curl.js                 parses pasted cURL / DevTools header-dump text into a headers object
  telegram.js             the only file that calls the Telegram Bot API
  adminAuth.js            session-token cookie (admin_auth) against the `sessions` collection; getCurrentAccount()/isAuthed()/createSession()/destroySession() (§23, rewritten 2026-09-22 — was a single shared ADMIN_PASSWORD)
  accounts.js             the `accounts` collection — dashboard login accounts, Owner/Viewer roles, scrypt password hashing (§23, added 2026-09-22)
  monitorState.js         getRunning/setRunning on settings/_id:'status'.running
  myntra.js                Myntra API calls + per-order/per-item Telegram text formatting; fetchPackedCount() (getPostPackedOrders, paginated) for /packed; resolveReturnByTrackingId() (SPF claim -> packed-order lookup) for /api/resolve-return, see §21 (added 2026-09-22); fetchSpfTicketCounts() (spf/v2/getTickets, paginated, page/pageSize) for §24 (added 2026-09-22); fetchSpfPaidClaims() (per-paid-claim compensationAmount + tracking ids) for §24, lookupPackedShipment() (searchPostPackedOrder) for §25; myntraReturnType() customer-return-vs-RTO on each resolved return for §27 (added 2026-09-23)
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
  myntraCookies.js         rolling-session cookie merge after each Myntra call (§28, added 2026-09-23)
  ordersSnapshot.js        saved open-orders snapshots + per-order item cache the dashboard reads (§28, added 2026-09-23)
  sessionLifetimes.js      one row per session death, for measuring real lifetimes (§28, added 2026-09-23)
  returnTypeServer.js      myntraReturnTypeFor()/amazonReturnTypeFor() — server-side return type for the add routes (§27, added 2026-09-23)
  returns.js               addReturnToStockManager() — POSTs a return to stock-manager's own /api/register, same auth pattern as addToReadyToShip(); `channel` defaults to MYNTRA, AMAZON for §26; `returnType` CUSTOMER/RTO/UNKNOWN for §27 (§22, added 2026-09-22)
  spfPaid.js               fetchSpfPaidBreakdown() — splits the SPF paid total into fake/wrong/unclear/gradedOther/notLogged by matching paid claims to stock-manager's return log (§24, added 2026-09-23)
  amazonScan.js            lookupAmazonPacked()/lookupAmazonReturn() for the Amazon Pack/Return pages — orders-api search (qt=tracking-id) + order detail, returns/api search, RTO fallback + returnType (§26, §27, added 2026-09-23)
  DashboardContext.js      DashboardProvider/useDashboard() — every cross-page dashboard state + the single 60s poll loop (§7, added 2026-09-22, was inline in app/page.js)
  format.js                timeAgo/formatMinutes/otcLines/RETURN_CONDITIONS/RETURN_CONDITION_LABELS, shared by multiple pages (§7, added 2026-09-22)
components/
  BarcodeScanner.js        full-screen camera barcode scanner (@zxing/browser), plain JS/JSX port of what was originally stock-manager's own BarcodeScanner.tsx (§22, added 2026-09-22)
  OrderIdScanner.js        full-screen camera OCR reader (tesseract.js, lazy-loaded) for a printed Amazon order ID — 3-7-7 digit shape, two matching frames required (§26, added 2026-09-23)
  AmazonScanShared.js      Tracking/Order ID toggle + input + camera, status badge, item card — shared by the two Amazon scan pages only (§26, added 2026-09-23)
  ReturnTypeTag.js         Customer return / RTO / Unknown tag shown on Myntra Return + Amazon Return, Owner-only (§27, added 2026-09-23)
  AppShell.js              sidebar + topbar shell every page renders inside, wired in app/layout.js (§7, added 2026-09-22)
  LoginScreen.js           the login form, rendered by AppShell while not authed (§7, added 2026-09-22)
  icons.js                 every inline SVG icon component, shared across pages/shell (§7, added 2026-09-22)
  OrdersGrid.js            the "Open orders" grid + platform filter, extracted so both `/` and `/orders` can render it without duplicating the logic (§7, added 2026-09-22)
app/
  page.js                  Overview page — stat grid + error banners (§7, rewritten 2026-09-22, was the whole dashboard)
  orders/page.js           Open orders grid + platform filter (§7, added 2026-09-22)
  returns/page.js          Myntra Return — scan a Myntra return (§7, §22, added 2026-09-22)
  packed/page.js           Myntra Pack — scan a Myntra packed/picked label (§25, added 2026-09-23)
  amazon-packed/page.js    Amazon Pack — tracking or order ID lookup (§26, added 2026-09-23)
  amazon-returns/page.js   Amazon Return — tracking or order ID lookup + add to stock-manager (§26, added 2026-09-23)
  sessions/page.js         Refresh Myntra/Amazon session forms + session history (§7, added 2026-09-22)
  recipients/page.js       Alert recipients + OTC scope + role change history, Owner-only (§7, §19, §20, added 2026-09-22)
  team/page.js             Dashboard accounts CRUD, Owner-only (§7, §23, added 2026-09-22)
  spf-status/page.js       Owner-only SPF claim counts page — total/Approved/Paid/Rejected + full breakdown, paid ₹ split into Fake/Wrong + "paid claims to check" list, on demand only (§24, added 2026-09-22)
  layout.js                root layout — wraps every page in DashboardProvider + AppShell (§7)
  api/telegram-webhook/route.js   Telegram's webhook target — command parsing/dispatch, Owner-gated (§20)
  globals.css              all dashboard styling, theme (light/dark) CSS variables, sidebar/shell layout (§7)
  api/
    check-orders/route.js         cron endpoint (§6)
    check-amazon-orders/route.js  cron endpoint (§6)
    check-cancellations/route.js  cron endpoint (§6)
    check-otc/route.js            cron endpoint (§6, §19)
    otc-config/route.js           GET/PATCH — OTC alert's Owner-vs-Broadcast scope setting (§19)
    otc-status/route.js           GET — today's OTC codes + window countdown; PATCH — Clear (display-only) (§19)
    packed-count/route.js         GET — today's Myntra packed-order count (added 2026-09-22, see note below)
    spf-status/route.js           GET — SPF ticket counts by status, Owner-only, on demand (§24)
    resolve-return/route.js       GET — resolve a Myntra return tracking id to SKU/size/photo, for stock-manager (§21)
    dashboard/resolve-return/route.js   GET — same resolver, admin_auth-gated + catalog-matched, for this app's own dashboard (§22)
    dashboard/add-return/route.js       POST — log a Myntra return into stock-manager (§22)
    dashboard/packed-lookup/route.js    GET — Myntra Pack lookup by tracking number / packet id (§25)
    dashboard/amazon-packed-lookup/route.js   GET ?mode=tracking|order — Amazon Pack lookup (§26)
    dashboard/amazon-return-lookup/route.js   GET ?mode=tracking|order — Amazon Return lookup, catalog-matched (§26)
    dashboard/amazon-add-return/route.js      POST — log an Amazon return into stock-manager, channel AMAZON (§26)
    spf-status/verify/route.js          POST — confirmation-password gate; for Paid, computes the ₹ total + fake/wrong split (§24)
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
  classify-return-types.js   one-off, read-only: customer return vs RTO for every existing stock-manager return -> JSON, applied by stock-manager's apply-return-types.ts (§27)
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
- **Camera scan**: `components/BarcodeScanner.js` — a plain-JS/JSX port of what was originally
  stock-manager's own `BarcodeScanner.tsx` (that copy was later removed along with its whole scan
  box, once this app's own dashboard version covered the same need — see stock-manager's own
  PROJECT.md; this is now the only copy). Full-screen overlay, rear camera preferred automatically, scans until a code
  is found or cancelled. `playsInline` on the `<video>` is required for iOS Safari specifically, or
  it forces its own native fullscreen player instead. `DecodeHintType.POSSIBLE_FORMATS` restricts
  decoding to the 1D formats tracking/label barcodes actually use (CODE_128/CODE_39/EAN_13/EAN_8/
  UPC_A/ITF) instead of zxing trying every symbology it knows, and `TRY_HARDER` is on for more
  thorough scanline analysis. `@zxing/library` (a peer dep of `@zxing/browser`, previously only
  resolved transitively) is a direct dependency since these hint types are imported from it
  directly.
  - **Rearchitected for angle/contrast robustness (2026-09-22)**: originally used `@zxing/
    browser`'s own `decodeFromConstraints()` continuous-video-decode helper (single orientation
    per frame). Real user feedback: a sideways or upside-down label never decoded (1D readers scan
    horizontal lines — a rotated barcode just isn't found no matter how many times the same
    orientation is retried), and a faintly/lightly printed label often didn't either. Replaced with
    a component-driven loop: raw `getUserMedia()` (not the wrapper) + its own `setInterval`
    (120ms — was 75ms, since each tick now does more work) that, per tick, draws the current video
    frame onto a canvas at **all 4 cardinal rotations** (`ROTATIONS = [0, 90, 180, 270]`) with a
    `contrast(1.4) brightness(1.15)` canvas filter applied first, trying `reader.decodeFromCanvas()`
    at each until one succeeds. A normally-aligned, well-lit scan still resolves on the very first
    (0°) attempt — same speed as before; the extra rotations/contrast pass only cost anything on
    frames that don't decode plainly. A `busy` flag skips a tick outright rather than letting
    attempts queue up if a capture ever runs long.
  - **Flashlight toggle**: if the camera track's `getCapabilities().torch` reports support, a 🔦
    button appears in the scanner header (`track.applyConstraints({ advanced: [{ torch }] })`) —
    real extra light is the most reliable fix for a genuinely faint print that software contrast
    boosting alone can't fully recover. Hidden entirely on devices/browsers that don't support it
    (most laptops, some iOS versions).
  - Media stream is now stopped manually (`stream.getTracks().forEach(t => t.stop())`) on unmount
    and on a successful detection, since this no longer goes through `@zxing/browser`'s own
    `controls.stop()` continuous-decode helper.
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

- **Scanned this session (added 2026-09-23)**: same in-memory list as Scan Packed (§25) — last 10
  tracking ids scanned in this tab, each with its items' SKU/size and whether each was added (and
  as which condition); gone on refresh, per device, nothing saved. Also a "already scanned this
  session" note, and the input clears + refocuses after a lookup (mouse/keyboard devices only) so a
  USB scanner can scan back-to-back. "Add to Return" now logs against the tracking id that was
  actually resolved (`resolvedId`), not whatever is in the input box at the time of clicking.

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
- **`GET/POST /api/accounts`, `PATCH`/`DELETE /api/accounts/[username]`** (Owner-only) — list,
  create, change-role, remove dashboard accounts. New accounts default to Viewer in the UI but
  Owner can pick either role. `setAccountRole()` (`lib/accounts.js`, added 2026-09-22) has the
  same guards as `deleteAccount()`: refuses the protected founding Owner, and refuses demoting the
  last remaining Owner. Changing a role also kills that account's active sessions (same as
  removing one) — a session's `role` is cached at login time in the session row itself, so without
  this an already-logged-in account would keep the OLD role's access until it happened to log in
  again.
- **Second confirmation password on every Team change (added 2026-09-22)** — adding, re-roling, or
  removing a dashboard account now prompts for the same `ROLE_CHANGE_PASSWORD` env var the
  Telegram recipients routes already use (`promptAccountPassword()` in `lib/DashboardContext.js`,
  checked again server-side in every `/api/accounts*` route via `confirmPassword` in the body —
  same "never trust the client-side prompt alone" rule). One shared password across both
  recipient-role changes and dashboard-account changes, not a separate one to remember.
- **UI**: login form gained a Username field. Header shows `username · Owner`/`Viewer` + a Log out
  button. The Team page is now two cards (matching Alert recipients' own split into "recipients" +
  "role history"): **"Add someone"** (the add-account form) and **"Team members"** (the list) —
  originally one card, split 2026-09-22 for clearer visual separation (see the "card UI" note
  below). Each member row has a live Owner/Viewer role toggle (`.role-group`/`.role-btn`, same
  component the Alert recipients page already uses) instead of a static badge, disabled for the
  protected founding Owner.
- **Content no longer centered (fixed 2026-09-22)**: `.shell-content` had `max-width: 920px;
  margin: 0 auto`, which centered that 920px block inside whatever width `.shell-main` actually
  had — on any screen wider than about 1160px this left a large **empty gap on both sides**,
  including between the sidebar and the cards themselves, which read as "cards floating in the
  middle of the page." Changed to `max-width: 1200px` with no auto-margin, so content starts
  right after the sidebar and is only capped (not centered) on very wide screens.
- **Owner-only so far**: the "Dashboard team" card, the "Alert recipients" card (including the OTC
  alert's Owner-vs-Broadcast scope toggle it contains), and "Role change history" — hidden in the
  UI for a Viewer AND enforced server-side via a new shared `requireOwner()` guard in
  `lib/adminAuth.js`, applied to all 4 `/api/recipients*` routes and both `/api/accounts*` routes
  (never just hide-in-UI — a Viewer calling those routes directly still gets a real 403). Everything
  else (Start/Stop, Check now, Refresh Myntra session, Add to Return, the order grid, OTC status
  display, packed count) still works the same for both roles once logged in — narrowing what a
  Viewer can do on the *rest* of the dashboard is a deliberately separate follow-up, not assumed
  here (asked for "just this first").
- **Seeded via `scripts/seed-dashboard-owner.js`** (one-off, run once): creates `gaurav` as the
  protected founding Owner. Verified live: login (correct password, wrong password, unknown
  username), account creation, the protected/last-Owner delete refusals, and cleanup all behaved
  correctly against production before this shipped.

## 24. SPF claim status page (`app/spf-status/page.js`, added 2026-09-22)

A dedicated Owner-only page — the first real second page/route in this app (everything else lives
on the single dashboard at `/`) — showing SPF claim (ticket) counts: total, Approved, Paid,
Rejected, plus a full breakdown by every other status.

- **`fetchSpfTicketCounts()`** (`lib/myntra.js`) — paginates Myntra's `GET /api/spf/v2/getTickets`
  (a *different* pagination shape from every other endpoint here: `page`/`pageSize`, not
  `start`/`fetchSize`), querying every known status explicitly (`SPF_TICKET_STATUSES`, matching a
  real captured request from Myntra's own frontend) so nothing is silently excluded by some other
  default filter. Tallies every ticket by its `status` field. Verified live against production:
  paginated total (138, across 3 pages) matched the response envelope's own `totalCount` exactly.
- **`GET /api/spf-status`** (new, Owner-only via `requireOwner()`) — calls it, returns
  `{ total, byStatus: {...} }`.
- **Deliberately never polled** — not in the cron checks, not in the main dashboard's poll loop,
  not even fetched until this specific page is opened (fetches once on mount, plus a manual
  Refresh button). Paginating every SPF ticket is meaningfully heavier than the other on-demand
  stats (packed count, §19's OTC) — 3 live Myntra calls just to load this page once.
- **UI**: 4 headline `stat-card`s (Total claims / Approved / Paid / Rejected — `ACCEPT`/
  `PAYMENT_COMPLETED`/`REJECT` under the hood) plus a "Full breakdown" card listing every other
  status present. Reachable from the sidebar's "SPF Status" link (Owner-only, §7).
- **Owner-only both ways**: hidden from a Viewer in the sidebar nav and enforced server-side by
  `/api/spf-status` itself via `requireOwner()` — same rule as §23's other Owner-gated surfaces,
  never just hide-in-UI.

### Paid total + click-to-reveal-with-password (added 2026-09-22)

All 4 stat cards are `<button>`s showing their real count plainly (no "Click to reveal"
placeholder — the count itself was never sensitive). Clicking one prompts for the same
`ROLE_CHANGE_PASSWORD` confirmation password used everywhere else in this app (§23's Team page,
the Telegram-recipient role changes) — checked server-side by `POST /api/spf-status/verify`
(Owner-gated, compares `confirmPassword` against `process.env.ROLE_CHANGE_PASSWORD`, never ships
the secret itself to client JS).

- **Only "Paid" does anything extra**: on success it also shows a ₹ total — the real amount
  actually paid out, which took two wrong tries to get right (both confirmed live against
  production, not guessed):
  1. First assumed `finalAmount` was already present on the `GET /api/spf/v2/getTickets` list
     response, in a per-row `meta` field. Wrong — a real `PAYMENT_COMPLETED` row from that
     endpoint has no `meta` field at all.
  2. Then fetched `meta.finalAmount` from the per-claim `fetchNewClaim` response instead (the
     same endpoint `fetchSpfClaims`/`fetchClaimTrackingByReturnId` already use). This DOES exist,
     but it's the **product's selling price**, not the payout — a claim with
     `meta.finalAmount: "1989.0"` had `compensationAmount: 1137.49` on that same claim, tied to a
     real bank `utr` transfer reference. `compensationAmount` (top-level on the claim, roughly
     tracking `cogs`, consistently lower than `finalAmount`) is the actual amount Myntra paid —
     confirmed across several real paid tickets before switching to it.
  So the real total costs **one extra Myntra call per paid ticket** — `fetchSpfPaidTotal()`
  (`lib/myntra.js`) fetches all tickets, filters to `PAYMENT_COMPLETED`, then queries each one's
  claim detail with limited concurrency (`PAID_TOTAL_CONCURRENCY = 8`, same pattern as
  `resolveTrackingIdsForTickets`) and sums `compensationAmount`. ~15% of paid tickets come back
  with `returnId: null` from the list endpoint — `fetchNewClaim` also accepts a ticket's
  `orderId` as a fallback lookup key (verified live), matching the returned claim back to the
  ticket by `ticketId` in case an order ever has more than one SPF ticket. Verified against
  production: all 72 paid tickets resolved (61 by `returnId`, 11 more via the `orderId`
  fallback), totalling ₹68,899.66 (~2.5s at concurrency 8).
- **Deliberately not part of `fetchSpfTicketCounts()`** — too heavy (72 extra live calls) to run
  on every page load/Refresh. `POST /api/spf-status/verify` only calls `fetchSpfPaidBreakdown()` when
  `body.key === 'paid'`; the other 3 cards' password check is a no-op beyond validating the
  password, per the original request: "make all other also clickable and ask for passsword but
  just show real number on paid on other do nothing."
- **Fake / Wrong split under the Paid total (added 2026-09-23)** — `lib/spfPaid.js`'s
  `fetchSpfPaidBreakdown()`. `lib/myntra.js`'s `fetchSpfPaidTotal()` was split into
  `fetchSpfPaidClaims()` (every paid claim's `amount`, `issueCategory`, `skuId`,
  `meta.returnTrackingId`, original `trackingId` + a `failed[]` list with reasons) and a thin
  `fetchSpfPaidTotal()` on top. Hardened at the same time: a claim is only accepted if its own
  `ticketId` matches (the old `|| rows[0]` fallback could have counted another ticket's payout),
  the `orderId` lookup is retried when the `returnId` one doesn't contain the ticket, a 401/403 /
  soft session-expiry aborts the whole call instead of being swallowed per ticket (it used to
  read ₹0), and tickets that fail go into `failed[]` (shown on the card) instead of vanishing.
  - **Why stock-manager, not Myntra**: checked live, Myntra's own `issueCategory` (it IS on the
    `getTickets` list rows) is `WRONG_RETURNS_RECEIVED_OTHER_SELLERS_PRODUCT` for 70 of 72 paid
    claims (+1 `STAINED_RETURN`, 1 `WRONG_RETURNS_RECEIVED_OWN_PRODUCT`) — no fake category at all.
    Fake vs wrong only exists as the `condition` stock-manager graded the return with.
  - **Matching** (`lookupReturnsByTracking()` in `lib/stock.js`, read-only, `RETURNED` rows of
    `stockmovements`, tracking ids normalised exactly like stock-manager's `normalizeTracking`,
    legacy `condition: null` treated as GOOD like its `editEntry()` does): return tracking id
    first, then the original shipment tracking id (14 of 72 paid claims have no return tracking
    id; 11 of those were logged under the original label — verified live). Claims sharing one
    tracking id share its rows, consumed **one unit at a time** (a `qty` 2 row covers two claims,
    a qty 1 row can't be counted twice). When there's a choice (several claims, or mixed
    conditions), the claim's seller SKU is resolved via `fetchPackedOrderByTracking` (cached per
    tracking id, only for those cases) and rows are narrowed by SKU suffix. FAKED/WRONG beats
    GOOD/USED on the same parcel (a paid claim is for the bad unit — real case: a qty-2 shipment
    with one GOOD and one WRONG unit of the same SKU); FAKED **and** WRONG left → `unclear`.
  - **Buckets**: `fake`, `wrong`, `unclear`, `gradedOther` (GOOD/USED/DEFECTIVE — Myntra paid it,
    so probably mis-graded), `notLogged`. Summed in paise; if buckets ever don't add up to the
    total the split is withheld (`breakdownError`) rather than shown wrong. If stock-manager's DB
    is unreachable the total still shows, with `breakdownError`. Every non-fake/wrong claim is
    returned in `review[]` and listed on the page ("Paid claims to check") with its tracking id,
    so it can be re-graded in stock-manager.
  - **Verified against production** (2026-09-23): 72/72 paid claims resolved, ₹68,899.66 =
    Fake ₹24,066.05 (26) + Wrong ₹35,193.28 (34) + Graded good/used ₹7,652.86 (9) + Not logged
    ₹1,987.47 (3). ~3s. Edge cases (multi-item SKU split, unclear, over-claimed tracking id, qty
    2 rows, fallback key, no tracking, stock-manager down, auth error mid-lookup) checked with a
    synthetic run.
- **Why a password check here even for the 3 cards that reveal nothing extra**: their counts are
  already visible on the page (this isn't an access-control boundary for them), it's the same
  friction-on-an-already-authenticated-Owner pattern §23 documents for account changes. For Paid,
  the password check also gates a real, non-trivial computation from running unauthenticated.

## 25. Scan packed / picked (`app/packed/page.js`, added 2026-09-23)

Sidebar item **Scan Packed**, right below Scan Return, visible to Owners and Viewers alike (same
as Scan Return). Scan a shipping label with the camera (`components/BarcodeScanner.js`, same as
Scan Return), a USB/Bluetooth scanner, or type it — shows the packet's status (Packed / Picked /
Shipped), a timeline — Packed, Pack by, Picked, Pick by, Shipped (IST; each row only when Myntra has set it —
no order date: searchPostPackedOrder returns neither an order date nor an order id; Pack by/Pick by are Myntra's own `packByTime`/`pickByTime`,
its exact meaning of pick-by isn't documented) — and per item: photo, product name, seller SKU, size,
color, qty, selling price/MRP. Read-only, one live Myntra call per scan, never on a timer.

- **Endpoint**: `lookupPackedShipment()` in `lib/myntra.js` → `searchPostPackedOrder` (the same
  endpoint §21's return resolver uses for step 2). NOT the `getPostPackedOrders` date-range list
  the packed count uses — that one only carries `skuId` per line item, no name/SKU/size/color/
  image; the search endpoint has all of it (`productDisplayName`, `sellerSkuCode`, `size`,
  `color`, `images[]`, `mrp`, `finalAmount`) plus `packedOn`/`pickedOn`/`shippedOn`/`packetStatus`.
- **Verified live quirks**: the id must be uppercase — a lowercased tracking number is an HTTP 500,
  same as an unknown one, so input is uppercased and stripped to A–Z/0–9 first. An unknown id or a
  return label (MYSR…/MYER…, not an outbound packet) comes back as HTTP 500 "Error in APIGATEWAY",
  not an empty list — treated as "not found" (404 from `GET /api/dashboard/packed-lookup`, with a
  "use Scan Return" hint for MYSR/MYER). An all-digits code is looked up as the packet id
  (`searchOn=storePacketId`, also verified); `orderId`/`packetId` aren't valid search keys.
  Session expiry (soft or 401/403) → 401 "refresh it on the Sessions page".
- **Scanner ergonomics**: the input re-focuses after each lookup on mouse/keyboard devices only
  (`pointer: fine`), so a USB scanner can scan back-to-back; on phones that would pop the keyboard
  after every camera scan. A "Scanned this session" list (last 10, in memory only) and a note when
  the same label is scanned twice. Multi-item packets show every line item.

## 26. Amazon Pack & Amazon Return scan pages (added 2026-09-23)

Two sidebar items below Scan Packed — **Amazon Pack** (`app/amazon-packed/page.js`) and **Amazon
Return** (`app/amazon-returns/page.js`). Separate from the Myntra scan pages, which are untouched
(the only shared change: `lib/returns.js`'s `addReturnToStockManager` gained a `channel` option,
default `'MYNTRA'`). Both pages have a **Tracking ID / Order ID** toggle (tracking is the default;
the choice is remembered per page in localStorage):
- Tracking ID → the camera opens the existing barcode scanner.
- Order ID → the camera opens `components/OrderIdScanner.js`, an OCR reader (tesseract.js, loaded
  on first open — a few MB from its CDN, cached after) for the order number printed on the label.
  It crops the middle band of the frame, only accepts the Amazon 3-7-7 digit shape, and only after
  **two consecutive frames agree**, so other numbers on the label (tracking, PIN, phone) and
  one-off misreads are ignored. Also maps O→0. Typed ids work with or without dashes/spaces.

Lookups live in `lib/amazonScan.js` (read-only, saved `session_amazon` headers). Verified live:
- Pack by tracking: `orders-api/search?...&q=<tracking>&qt=tracking-id&date-range=last-365` —
  **`qt=tracking-id` is required**; without it `q` is silently ignored and every order comes back.
  Then `orders-api/order/<id>` for the detail (packages → tracking, carrier, pickup slot,
  items with SellerSKU/title/image/price; purchase date, ship-by, deliver-by, status, label
  status, COD). Pack by order id goes straight to `orders-api/order/<id>` (`qt=order-id` is NOT
  honoured). Size/color come from the title/SKU via `lib/amazon.js`'s `extractVariant`.
- Return: `returns/api/return-requests?searchBy=CarrierTrackingId|OrderId&searchTerm=...`
  (`dateRange.selectedDateRange=365`) → order id, status, exchange/refund, return tracking +
  carrier, dates, and per item SKU/title/image/qty/reason/resolution. Items are matched to
  stock-manager's catalog (`lookupProductBySku`), and "Add to Return" posts via
  `POST /api/dashboard/amazon-add-return` → stock-manager `/api/register`, `channel: 'AMAZON'`,
  logged under the return label's tracking id.
- Expired Amazon session is HTTP 403 `{"reason":"sign_in"}` → a clear "refresh the session"
  error; a bare 403/429/5xx is retried once (Amazon's one-off bot blocks, see lib/amazon.js).
- Same "Scanned this session" list / repeat-scan note / USB-scanner focus as the Myntra pages.
- **Renamed (2026-09-23)**: the Myntra scan pages are now labelled **Myntra Return** (`/returns`)
  and **Myntra Pack** (`/packed`) in the sidebar and page headings, so they read clearly next to
  Amazon Pack / Amazon Return. Routes/URLs are unchanged.
- **RTO support on Amazon Return (added 2026-09-23)**: an Amazon RTO (parcel never reached the
  customer — COD refused / cancelled in transit — and came back) never creates a return request,
  so Manage Returns has nothing for it (verified on 404-0757348-7486720: 0 return requests,
  order status `ReturnedToSeller`). When the returns search is empty, `lookupAmazonReturn` now
  falls back to the order: Order ID mode reads `orders-api/order/<id>`; tracking mode tries the
  scanned number as the ORIGINAL outbound tracking (`qt=tracking-id`). If the order is
  `ReturningToSeller` or `ReturnedToSeller` it's shown as an **RTO** (red tag, COD flag,
  shipped / returning-since / returned dates from `easyship-api/v1/track` events) with the same
  condition picker + Add to Return, logged under the original tracking. The RTO parcel's own
  return-label number (e.g. 515230465036) isn't linked to the order anywhere Amazon lets us
  search, so scanning just that gives a clear "switch to Order ID" message. Delivered orders
  with no return get "has no customer return and isn't an RTO".
- **Myntra, for comparison (checked 2026-09-23, no code change)**: Myntra has both kinds too, and
  Myntra Return already resolves both — a customer return by its return label (MYSR…/MYER…), an
  RTO by its original outbound label (MYSC…/MYSP…/MYEC…/MYEP…): `fetchNewClaim` accepts the
  outbound tracking and reports `orderStatus: "RTO"` (some show `"F"`), with no return tracking /
  return date. The packet's own `packetStatus` stays `SHIPPED` for an RTO. ~137 of stock-manager's
  Myntra returns are logged under outbound prefixes, i.e. mostly RTOs. Myntra Return doesn't yet
  *label* which kind a scan is.

## 27. Return type — Customer return vs RTO (added 2026-09-23)

Both return scan pages now show whether a scan is a **Customer return**, an **RTO** (never reached
the customer, came back) or **Unknown** (`components/ReturnTypeTag.js`), and send it to
stock-manager as `returnType` (CUSTOMER / RTO / UNKNOWN) on Add to Return — stored on the
`RETURNED` row (see stock-manager's PROJECT.md). It's independent of the condition: an RTO can
still come back faked or wrong (real case: MYEP1132530153 — never delivered, came back on its
original label with another seller's product, SPF wrong-return claim approved).
- **Myntra** — `lib/myntra.js` `myntraReturnType(claim)`, from the claim record the resolver
  already fetches (no extra call): return date/reason → CUSTOMER; `orderStatus` `RTO` or `F` →
  RTO; else UNKNOWN. Verified against all 512 tracked Myntra returns: customer returns are always
  return labels (MYSR/MYER) with status `C`; RTOs come back on the original label with `RTO` (41)
  or `F` (96, undocumented by Myntra but always never-delivered + original label).
- **Amazon** — found in Manage Returns → CUSTOMER; the §26 RTO fallback (order
  `ReturnedToSeller`/`ReturningToSeller`) → RTO.
- `lib/returns.js` sends `returnType` (anything unrecognised → UNKNOWN); stock-manager's zod schema
  strips unknown keys on older deploys, so either app can be deployed first.
- **Owner-only (2026-09-23)**: the tag (and the RTO note/reason, and the type in "Scanned this
  session") is shown to Owners only. Server-side too: `/api/dashboard/resolve-return` and
  `/api/dashboard/amazon-return-lookup` strip `returnType` (and `rto` + the RTO reason) for
  non-Owners; the add routes don't trust the browser — `lib/returnTypeServer.js` re-derives the
  type from the same Myntra/Amazon lookup (falls back to the browser's value only for an Owner,
  else UNKNOWN), so a Viewer's adds are still stored with the right type and can't spoof it.
  Verified live: customer/RTO/multi-item RTO all derived correctly for a viewer; a viewer sending
  "RTO" for a customer return is stored as CUSTOMER.
- **Backfill**: `scripts/classify-return-types.js <out.json>` (read-only) classified the 681
  existing returns; stock-manager's `scripts/apply-return-types.ts` applied it (dry run first).
  Myntra 373 customer / 138 RTO / 4 unknown; Amazon 57 / 5 / 97; Flipkart 7 unknown.

## 28. Session keep-alive + marketplace call reduction (added 2026-09-23)

Why sessions "expired" while the seller was still logged in, and why the account's traffic looked
bot-like — measured live, then fixed in layers. Every layer fails safe (falls back to how things
worked before).

**Findings (verified live 2026-09-23)**
- Every successful partnersapi response carries Set-Cookie: `session` gets a NEW value on every
  call (rolling), `erp.at`/`erp.rt` are re-sent, Akamai's `bm_sv` (~80 min) is re-issued. The bot
  threw these away and replayed the extension's frozen copy until it aged out. Without `erp.at`
  Myntra answers `statusCode 101` "Session expired"; Akamai cookies (`ak_bmsc`, `bm_sv`) weren't
  needed for a call to work.
- Any HTTP 403 was treated as "session expired" — but Myntra fronts the API with Akamai Bot
  Manager, whose block is also a 403 (HTML, not Myntra's JSON). A real expiry is a 200 +
  `statusCode 101`.
- The dashboard's `/api/orders` called Myntra (1 + one-per-open-order, fired at once) and Amazon
  (2) LIVE every 60s per open tab, on every dashboard page (the poll lives in the shared layout),
  even in background tabs — ~11,500 calls/day for one tab left open, 10–15x the alert checks.

- **Root cause, confirmed**: `erp.at` = short-lived access token, `erp.rt` = refresh token. With
  a bad/expired `erp.at` but a good `erp.rt`, Myntra refreshes silently — the call succeeds and
  Set-Cookie carries a NEW `erp.at` and a NEW `erp.rt`; only both bad → statusCode 101. The bot
  discarded those, so its copy died whenever `erp.at` aged out. A superseded `erp.rt` still
  refreshed fine after newer ones were issued, so the bot refreshing does not log the browser out.

**Fixes**
- `lib/myntraCookies.js` + `myntraGet()` in `lib/myntra.js` (every Myntra call goes through it):
  merges Set-Cookie back into `settings/session` after each SUCCESSFUL call — only known session
  cookies, never deletions, never from a soft-expired response, compare-and-set on the exact
  cookie string sent (a newer sync is never overwritten); records `cookiesRolledAt`. Verified: the
  stored `session`/`bm_sv` roll and the session keeps working. A bare 403 that isn't Myntra JSON is
  retried once after 2.5s; if still blocked it's marked `err.blocked`.
- Dashboard makes **no marketplace calls**: `lib/ordersSnapshot.js`. The Myntra/Amazon order
  checks save what they fetched (`settings/snapshot_myntra_open`, `settings/snapshot_amazon_unshipped`);
  Myntra order items are cached per order in `myntraOrderItems` (written by the new-order alert,
  plus a backfill of ≤3 uncached open orders per check; dropped on cancellation; 45-day prune).
  `/api/orders` only reads these (same response shape; a note if a snapshot is >15 min old). The
  dashboard poll pauses while the tab is hidden. `/api/packed-count` is cached 10 min.
- `GET /api/session/health` (x-sync-secret): DB-only per-marketplace state
  `ok` / `expired` / `missing` / `error` from the checks' last result — never calls a marketplace.
- `/api/session/sync` rewritten: **every trigger tests the new session first** (one live call)
  and only saves it if it works. Refused with 409 `reason: 'session-not-working'` for a genuine
  rejection (401 / Myntra 101 / non-Akamai 403 / Amazon sign-in); 502 `probe-failed` for
  network/5xx/bot-protection (retry later). New trigger `'recovery'` → `markSessionRestored()`
  (clears the error, one quiet "restored automatically" note per outage; never resets the alert
  flag, so a flaky session can't loop alerts). Verified sync clears the stale error text
  (`clearSessionError`). Stores the extension's `syncPeriodMinutes`; the stale-sync watchdog now
  uses max(6h, period + 2h).
- `sessionLifetimes` collection (`lib/sessionLifetimes.js`): one row per session death (captured /
  died / lifetime / last cookie refresh / reason), written when the once-per-outage expiry alert
  fires; last 500 kept — so real lifetimes can be measured.

**Extension 1.1** (`browser-extension/`, must be reloaded once at `chrome://extensions`):
per-marketplace alarms `session-sync-market-<name>` with intervals set in the popup (15–1440 min,
default 240; the old shared `session-sync` alarm's countdown is carried over on update); a 1-minute
`session-health` alarm → if the bot says expired/missing and this browser still has its login
cookie (Myntra `erp.at`; Amazon `at-acbin`/`session-token`), a `'recovery'` sync — at most every
10/20/40/60 min (backoff), skipped if a sync succeeded <10 min ago or the bot's checks are stopped;
if logged out, no sync + "log in" + red badge; a copy the bot rejected isn't re-sent for 2h unless
the cookies change (new login). `session-not-working` never arms the 1–15 min backoff retries.
Simulated in Node with a mocked Chrome API (migration, intervals, single recovery, logged-out,
rejected copy, stopped bot, start/stop, schedules/retries) — all pass.

**Review pass (same day)**: cookie writes throttled to once a minute per server instance, but
immediate when `erp.at`/`erp.rt` change (the SPF page's ~140 calls no longer mean ~140 writes; a
skipped write leaves the in-memory copy untouched so the chain stays consistent, and the in-memory
copy only follows a write that actually matched). Session test for Amazon is one `limit=1` search
(`probeAmazonSession`) instead of a full 2-program fetch. A scheduled/retry sync of the SAME login
the bot already has working (same `erp.at`/`erp.rt`, or Amazon's `at-acbin`/`sess-at-acbin`/
`session-token`) makes no marketplace call and doesn't swap the bot's fresher rolled cookies for the
browser's — it just records `lastSyncedAt`, which the watchdog now reads. The "auto-sync ok"
heartbeat is sent at most once per marketplace every 4h, however short the interval.

**Marketplace calls after this** (5 open orders): Myntra ~600/day, Amazon ~1,150/day from the
timers, regardless of how many dashboard tabs are open (was +~11,500/day per open tab).
