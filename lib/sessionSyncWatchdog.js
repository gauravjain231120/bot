const { replyToChat } = require('./telegram');

// The browser extension (browser-extension/background.js) re-syncs the
// session every SYNC_PERIOD_MINUTES (4h), with its own per-marketplace
// backoff retries capped at 15 minutes. By design, a routine successful auto
// sync is SILENT — no Telegram message — to avoid spamming a "still fine"
// ping every few hours (see lib/sessionStore.js#announceSessionActivated and
// app/api/session/sync/route.js). That's fine while it's actually working,
// but it also means nothing ever told anyone if the alarm stopped firing
// (Chrome fully closed, extension disabled/removed, sync silently failing
// past its own retry backoff, etc.) — the stored session just goes stale
// with no signal anywhere until the marketplace itself eventually rejects it
// with a real 401/403, which can take up to ~24h. This watchdog closes that
// gap: if a session whose *source* is the extension hasn't refreshed in far
// longer than its own schedule should ever allow, say so proactively.
//
// 6h gives 4h (the period) + a couple hours of slack for retries/backoff and
// clock/poll jitter, so a single missed cycle that self-heals via retry
// never fires a false alarm.
const STALE_THRESHOLD_MS = 6 * 60 * 60 * 1000;

const TARGETS = [
  { sessionId: 'session', label: 'Myntra', staleFlag: 'extensionStaleAlertSent' },
  { sessionId: 'session_amazon', label: 'Amazon', staleFlag: 'amazonExtensionStaleAlertSent' },
];

// Called from the check-orders cron route on every tick (regardless of the
// running/stopped flag — the extension syncs on its own schedule, unrelated
// to whether alert-checking itself is paused), so this rides along on the
// same ~1-minute cadence without needing its own cron job.
async function checkExtensionSyncWatchdog(db) {
  const settings = db.collection('settings');

  for (const { sessionId, label, staleFlag } of TARGETS) {
    const sessionDoc = await settings.findOne({ _id: sessionId });
    // Only the extension's own schedule is being watched here — a session
    // pasted manually on the admin page has no timer to fall behind on, and
    // its absence/expiry is already covered by the existing session-missing/
    // expired alerts in checkOrders.js / checkAmazonOrders.js.
    if (!sessionDoc || sessionDoc.source !== 'extension' || !sessionDoc.capturedAt) continue;

    const ageMs = Date.now() - new Date(sessionDoc.capturedAt).getTime();
    const statusDoc = await settings.findOne({ _id: 'status' });

    if (ageMs < STALE_THRESHOLD_MS) {
      // Self-heals the moment a fresh sync lands — no separate reset path
      // needed elsewhere (e.g. sessionStore.js) for this.
      if (statusDoc && statusDoc[staleFlag]) {
        await settings.updateOne({ _id: 'status' }, { $set: { [staleFlag]: false } });
      }
      continue;
    }

    if (statusDoc && statusDoc[staleFlag]) continue; // already alerted for this outage

    const hours = Math.floor(ageMs / 3600000);
    await replyToChat(
      process.env.TELEGRAM_COMMAND_CHAT_ID,
      `⚠️ <b>${label} extension sync is stale</b>\n` +
        `Last synced ${hours}+ hour${hours === 1 ? '' : 's'} ago (expected every 4h). ` +
        `Check that Chrome is open with the extension running, or paste a fresh session on the admin page.`
    );
    await settings.updateOne({ _id: 'status' }, { $set: { [staleFlag]: true } }, { upsert: true });
  }
}

module.exports = { checkExtensionSyncWatchdog };
