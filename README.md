# Myntra Order Alert Bot

Admin app that polls Myntra M-Direct for new orders and alerts on Telegram (with product image + SKU).

## How it works

- Myntra's M-Direct seller portal has no official API, so this replays the internal JSON API
  (`partnersapi.myntrainfo.com`) that the portal's own frontend calls, using a session captured
  from a logged-in browser (bot detection on that API blocks automated *login*, confirmed by
  testing — so logging in stays manual; everything after that, including refreshing the session
  itself, can be automated — see `browser-extension/`).
- `/api/check-orders?secret=...` is the endpoint an external scheduler hits on a timer. It fetches
  currently open orders, diffs against a MongoDB-tracked set of already-seen order IDs, and sends
  a Telegram message (with image + SKU) for each genuinely new one.
- The `/` admin page (password-gated) is where you can paste a fresh session by hand whenever
  needed, and see basic status (last check, open order count, last error). In normal day-to-day
  use, though, a small Chrome extension (`browser-extension/`) does this automatically — see
  below.

## Dashboard pages

Besides the alerts, the logged-in dashboard has scan pages for the packing desk (camera, USB/Bluetooth
scanner, or typed):

- **Myntra Return** / **Myntra Pack** — scan a Myntra return or outbound label: product photo,
  SKU, size, dates; returns can be logged straight into stock-manager.
- **Amazon Pack** / **Amazon Return** — the same for Amazon, by the label's tracking barcode or by
  the order ID (the camera reads the printed number). Amazon returns log into stock-manager as
  channel AMAZON.
- Both return pages show whether a scan is a **Customer return** or an **RTO** (never reached
  the customer), and store that on the stock-manager return row.
- **SPF Status** (Owner-only) — Myntra SPF claim counts, and the ₹ Myntra actually paid split into
  Fake / Wrong returns.

See `PROJECT.md` §22–§26 for how each lookup works.

## Setup

1. `cp .env.example .env.local` and fill in the values (Telegram bot token/chat ID, a MongoDB
   Atlas connection string, an admin password, and a `CRON_SECRET` you'll also use in the
   scheduler URL).
2. `npm install && npm run dev`, then open `http://localhost:3000` and log in with your admin
   password.
3. To capture a session **by hand** (one-off, or if you're not using the extension): in your own
   logged-in Chrome, DevTools → Network → right-click a request to
   `partnersapi.myntrainfo.com/api/mdirect/orders/...` → Copy → Copy as cURL, then paste it into
   the admin page's "Refresh session" box.
   - **Or, to automate this**: set `EXTENSION_SYNC_SECRET` (see `.env.example`) and install
     `browser-extension/` in a Chrome that's kept logged into Myntra/Amazon — it reads the
     session cookies straight from Chrome's cookie jar (including the HttpOnly ones DevTools
     needs a manual copy for) and posts them to `POST /api/session/sync` on a timer. See
     `browser-extension/README.md`.
4. Point an external scheduler (e.g. cron-job.org, every 1–5 minutes) at
   `https://<your-deployment>/api/check-orders?secret=<CRON_SECRET>`.

## Notes

- This uses an unofficial, reverse-engineered internal API — it can break if Myntra changes their
  frontend, and may not be sanctioned by their ToS. Treat it as a best-effort tool.
- When the session expires, `/api/check-orders` starts returning 401s, the admin page's status
  shows the error, and you get one (loud) Telegram heads-up. A routine "session activated"
  confirmation (from a manual paste or the extension) is sent silently by design — only the
  expiry warning makes noise.
- **Known gap**: if the stored session is entirely *missing* (not just expired), the alert
  pipeline currently fails locally without sending a Telegram warning — only a real 401/403 from
  Myntra triggers the alert today. Worth fixing if this is ever hit in practice (see `PROJECT.md`
  §12).
