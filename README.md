# Myntra Order Alert Bot

Admin app that polls Myntra M-Direct for new orders and alerts on Telegram (with product image + SKU).

## How it works

- Myntra's M-Direct seller portal has no official API, so this replays the internal JSON API
  (`partnersapi.myntrainfo.com`) that the portal's own frontend calls, using a session captured
  from a logged-in browser (bot detection on that API blocks automated login, so login itself
  stays manual — only the polling is automated).
- `/api/check-orders?secret=...` is the endpoint an external scheduler hits on a timer. It fetches
  currently open orders, diffs against a MongoDB-tracked set of already-seen order IDs, and sends
  a Telegram message (with image + SKU) for each genuinely new one.
- The `/` admin page (password-gated) is where you paste a fresh session whenever the old one
  expires, and see basic status (last check, open order count, last error).

## Setup

1. `cp .env.example .env.local` and fill in the values (Telegram bot token/chat ID, a MongoDB
   Atlas connection string, an admin password, and a `CRON_SECRET` you'll also use in the
   scheduler URL).
2. `npm install && npm run dev`, then open `http://localhost:3000` and log in with your admin
   password.
3. To capture a session: in your own logged-in Chrome, DevTools → Network → right-click a request
   to `partnersapi.myntrainfo.com/api/mdirect/orders/...` → Copy → Copy as cURL, then paste it into
   the admin page's "Refresh session" box.
4. Point an external scheduler (e.g. cron-job.org, every 1–5 minutes) at
   `https://<your-deployment>/api/check-orders?secret=<CRON_SECRET>`.

## Notes

- This uses an unofficial, reverse-engineered internal API — it can break if Myntra changes their
  frontend, and may not be sanctioned by their ToS. Treat it as a best-effort tool.
- When the session expires, `/api/check-orders` starts returning 401s, the admin page's status
  shows the error, and you get one Telegram heads-up — just paste a fresh session.
