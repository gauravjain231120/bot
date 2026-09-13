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

After that it re-syncs on its own every 4 hours (`SYNC_PERIOD_MINUTES` in `background.js`) for as
long as Chrome is running — no further clicks needed.

## Using it day to day

- **Popup** shows a live countdown to the next auto-sync, and a colored dot per marketplace for
  the last sync's result.
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
| How often it auto-syncs | `SYNC_PERIOD_MINUTES` in `background.js`, then reload the extension |
| Which marketplaces it syncs / their cookie domain | the `MARKETPLACES` array in `background.js` |
| App URL / secret | the extension's own options page (not a file) |

After editing any `.js`/`.html`/`.json` file here, reload the extension at `chrome://extensions`
(click the ⟳ icon on its card) for the change to take effect.
