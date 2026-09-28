# Session Sync (browser extension)

Keeps the order-alert app's Myntra + Amazon session fresh automatically, by reading the session
cookies out of a browser that's already logged in normally — no password, no automated login.
See the main project's `PROJECT.md` §2 and §18 for why it's built this way.

## Install

1. Go to `chrome://extensions`.
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked**, select this `browser-extension/` folder.

## One-time setup

1. Click the extension's icon → **Setup / change app URL**.
2. Enter your deployed app's URL (e.g. `https://your-app.vercel.app`) and the value of that app's
   `EXTENSION_SYNC_SECRET` environment variable.
3. Save, and approve the permission prompt Chrome shows for that URL.
4. Make sure you're logged into Myntra M-Direct and/or Amazon Seller Central normally in this
   same Chrome.
5. Click the icon → **Sync now** to confirm it works right away.

After that it re-syncs on its own — every 4 hours by default, separately for Myntra and Amazon,
adjustable in the popup — for as long as Chrome is running. No further clicks needed.

## Using it day to day

- **Popup** shows the **session watch** (what the bot says about its Myntra/Amazon session, checked
  every minute), a colored dot per marketplace for the last sync's result, and a countdown to each
  marketplace's next auto-sync.
- **Session watch / auto-restore**: every minute the extension asks the bot — never Myntra or
  Amazon — whether its session still works. If the bot's session expired while this browser is
  still logged in, it re-syncs right away (at most once per 10 min, backing off to 60 min if it
  keeps dying). The bot waits up to 15 min for this before sending "session expired", so a session
  the extension restores never alerts at all; if an alert did go out, the restore is followed by a
  quiet "session restored automatically" note. If this
  browser is **logged out**, it does not sync (a logged-out copy can't work): the row says
  "Logged out — log in…", the icon shows a red "!", and it syncs by itself as soon as you log in.
- **New Amazon login → synced at once** (1.4): when this browser gets a new Seller Central login
  (its `at-acbin` / `sess-at-acbin` cookies change), the extension hands it to the bot within
  seconds instead of waiting for the timer — the bot's copy of the old login stops working soon
  after. At most once per 5 min; never re-sends a login the bot refused. If the bot can't test it
  right then (Amazon briefly unreachable), it tries again after 5, 15, 30, then 60 min — at most 8
  times for one login, counting the "waiting for a login" re-sync too (1.4.3; it used to be every
  5 min for as long as that lasted). These syncs don't move the 4-hourly timer, so Myntra's and
  Amazon's "auto-sync ok" keep arriving together.
- **Every scheduled sync refreshes the bot's copy** (1.4, bot side): the bot tests this browser's
  current cookies and switches to them each time (it used to keep its own aging Amazon copy when
  the login was unchanged — that copy kept dying ~10 h in).
- **"🔄 auto-sync ok"**: at most one per marketplace every ~4 h; a retry of the scheduled sync that
  succeeds sends it too (a retry of a failed **Sync now** click doesn't — 1.4.2).
- **Sync now** answers on Telegram (Owner only, silent): "✅ … session working — checked now, same
  login as before", "✅ … session working — checked now; the bot saved this browser's latest login"
  (usual for Myntra: its login token renews every few hours), or "✅ … session restored" after an
  expiry. All three mean it works.
- **Auto-sync every (minutes)**: set Myntra and Amazon separately (15–1440, default 240) and
  Save. A shorter interval takes effect right away; a longer one from the next cycle.
- **Logged out = no sync at all**: every sync first checks this browser's login; if you're logged out
  it doesn't send anything (so no Myntra/Amazon call is spent testing a dead copy) — the row just
  says "Logged out — log in…" until you do. **Then it syncs by itself** a few seconds after you log
  in (it watches for the login cookie) — no need to click ↻ or wait for the timer.
- **The bot tests every session before using it**: a copy that doesn't work (logged out, stale)
  is refused and the bot keeps its current, working session — syncing can never break it.
- **Sync now** always works immediately, regardless of the timer or the Stop/Start state below.
- **Stop auto-sync** / **Start auto-sync** pauses/resumes the timer without uninstalling anything
  — useful if you want to temporarily stop it without losing the setup. Starting again also
  syncs immediately.
- Closing and reopening Chrome doesn't reset the countdown. If the timer's due time already
  passed while Chrome was closed, it syncs right away when you reopen. If it hadn't, the
  countdown just keeps going from where it left off — reopening Chrome doesn't force an early
  sync.

## Multiple devices

Installing this on more than one device is fine and gives you redundancy — each device runs its
own independent timer and just posts to the same app. Whichever synced most recently is simply
what the app currently uses; there's no conflict, and stopping/removing it on one device doesn't
affect any other.

## When it can't help

- **You're actually logged out** of Myntra/Amazon in that browser: there's nothing to read, so
  the sync fails with a clear error ("No cookies found for ... — log in there first"). Log in
  normally, like you always would, then sync again (or just wait for the next automatic one).
- **Nothing can trigger this remotely** (not even a Telegram command) — the server has no way to
  reach into a browser's cookie jar; only the browser can push cookies out.

## Changing settings

| Want to change | Edit |
|---|---|
| How often it auto-syncs | the popup's "Auto-sync every (minutes)" box — per marketplace, no reload needed |
| Which marketplaces it syncs / their cookie domain | the `MARKETPLACES` array in `background.js` |
| App URL / secret | the extension's own options page (not a file) |

**Updating to 1.1 / 1.2 / 1.3 / 1.4 / 1.4.1 / 1.4.2 / 1.4.3**: reload it once at `chrome://extensions` (⟳). The popup's
footer shows the running version. (1.4+: right after reloading, the next session check syncs Amazon
once — that's expected.) Your current countdown carries
over to both marketplaces' new timers; nothing needs re-entering.

After editing any `.js`/`.html`/`.json` file here, reload the extension at `chrome://extensions`
(click the ⟳ icon on its card) for the change to take effect.
