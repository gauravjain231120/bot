const { sendTelegramMessage } = require('./telegram');

// If Start never gets pressed again after a cleanup/pause, orders silently
// pile up unnoticed — this has happened more than once. One reminder ping
// after the service has sat stopped for a while, not a repeating nag.
const STOPPED_ALERT_THRESHOLD_MS = 3 * 60 * 60 * 1000; // 3 hours

// Called from the check-* cron routes on every tick where the service is
// currently stopped (they already run on a schedule regardless of the
// running flag, so this rides along without needing its own cron job).
async function checkStoppedWatchdog(db) {
  const settings = db.collection('settings');
  const status = await settings.findOne({ _id: 'status' });
  const now = new Date();

  // Self-heal: if we don't know when it stopped (e.g. this feature just
  // shipped, or running was flipped by a direct DB write), start the clock
  // now instead of guessing backwards — avoids firing an alert immediately.
  if (!status || !status.stoppedAt) {
    await settings.updateOne({ _id: 'status' }, { $set: { stoppedAt: now.toISOString() } }, { upsert: true });
    return;
  }

  if (status.stoppedAlertSent) return;

  const stoppedMs = now - new Date(status.stoppedAt);
  if (stoppedMs < STOPPED_ALERT_THRESHOLD_MS) return;

  const hours = Math.floor(stoppedMs / 3600000);
  await sendTelegramMessage(
    `⏸️ Order alerts have been stopped for ${hours}+ hour${hours === 1 ? '' : 's'}. Press Start on the dashboard if this wasn't intentional.`
  );
  await settings.updateOne({ _id: 'status' }, { $set: { stoppedAlertSent: true } }, { upsert: true });
}

module.exports = { checkStoppedWatchdog };
