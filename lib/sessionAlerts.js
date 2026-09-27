const { recordSessionDeath } = require('./sessionLifetimes');
const { sendOwnerAlert } = require('./telegram');

// The once-per-outage "session expired / missing" alert, shared by the Myntra
// (checkOrders.js) and Amazon (checkAmazonOrders.js) checks.
//
// When the browser extension manages the session, a dead session is normally
// back within a minute or two without anyone doing anything: the extension
// polls /api/session/health every minute, sees "expired" and re-syncs from
// the still-logged-in browser (background.js checkHealth → 'recovery').
// Alerting on the first failed check made every one of those self-healing
// blips look like an outage — 4 of the 6 Amazon deaths logged by 2026-09-26
// were restored this way within seconds to minutes, each after a
// "⚠️ Amazon session expired" alert had already gone out. So:
//   - the first failed check records the death (sessionLifetimes) and the
//     time it started failing;
//   - while the extension is actively syncing that session, the alert waits
//     up to EXTENSION_GRACE_MS for the extension to restore it — no alert at
//     all if it does;
//   - still failing after that (or no extension involved: a pasted session,
//     no session at all) → the alert goes out, once per outage as before.
// The first successful check clears it all (sessionOkFields).

const EXTENSION_GRACE_MS = 15 * 60 * 1000;

const FIELDS = {
  myntra: {
    label: 'Myntra',
    sessionId: 'session',
    alertSent: 'sessionExpiredAlertSent',
    restoreNotice: 'restoreNoticeSent',
    failingSince: 'sessionFailingSince',
  },
  amazon: {
    label: 'Amazon',
    sessionId: 'session_amazon',
    alertSent: 'amazonSessionExpiredAlertSent',
    restoreNotice: 'amazonRestoreNoticeSent',
    failingSince: 'amazonSessionFailingSince',
  },
};

// Is the extension keeping this session synced right now? Same "not stale"
// rule as the stale-sync watchdog: it checked in within its own interval + 2h.
function extensionIsManaging(sessionDoc, now) {
  if (!sessionDoc || sessionDoc.source !== 'extension') return false;
  const last = new Date(sessionDoc.lastSyncedAt || sessionDoc.capturedAt || 0).getTime();
  const periodMs = (Number(sessionDoc.syncPeriodMinutes) || 240) * 60 * 1000;
  return Number.isFinite(last) && now - last < periodMs + 2 * 60 * 60 * 1000;
}

/**
 * A check found the session rejected (or missing). `sessionDoc` is the stored
 * session the check used (null when there isn't one — alerts at once).
 * Injectable deps are for tests.
 */
async function noteSessionFailure(settings, marketplace, message, {
  sessionDoc = null,
  now = Date.now(),
  alert = sendOwnerAlert,
  recordDeath = recordSessionDeath,
  // false = alert without waiting for the extension (it can't fix this kind
  // of failure — e.g. Amazon blocking every request for 30 min).
  grace = true,
} = {}) {
  const f = FIELDS[marketplace];
  const status = (await settings.findOne({ _id: 'status' }, { projection: { [f.alertSent]: 1, [f.failingSince]: 1 } })) || {};
  if (status[f.alertSent]) return { alerted: false, already: true };

  let since = status[f.failingSince] ? new Date(status[f.failingSince]).getTime() : NaN;
  if (!Number.isFinite(since)) {
    since = now;
    await settings.updateOne({ _id: 'status' }, { $set: { [f.failingSince]: new Date(now).toISOString() } }, { upsert: true });
    await recordDeath(marketplace, message);
  }

  const managed = grace && extensionIsManaging(sessionDoc, now);
  if (managed && now - since < EXTENSION_GRACE_MS) return { alerted: false, waiting: true };

  // Claim the once-per-outage flag atomically before sending, so two checks
  // failing at the same moment can't both alert; give it back if nobody got
  // the message, so the next check tries again.
  const claimed = await settings.findOneAndUpdate(
    { _id: 'status', [f.alertSent]: { $ne: true } },
    { $set: { [f.alertSent]: true, [f.restoreNotice]: false } },
    { returnDocument: 'after' }
  );
  if (!claimed) return { alerted: false, already: true };
  const minutes = Math.round((now - since) / 60000);
  const text = managed
    ? `${message}\nFailing for ${minutes} min — the browser extension couldn't restore it. Log in to ${f.label} again in Chrome (the extension re-syncs by itself).`
    : message;
  const res = await alert(text).catch(() => ({ sent: 0 }));
  if (res && res.sent === 0) {
    await settings.updateOne({ _id: 'status' }, { $set: { [f.alertSent]: false } });
    return { alerted: false, undelivered: true };
  }
  return { alerted: true };
}

/** Fields a successful check sets on `status`: re-arms the alert, ends the outage. */
function sessionOkFields(marketplace) {
  const f = FIELDS[marketplace];
  return { [f.alertSent]: false, [f.failingSince]: null };
}

module.exports = { noteSessionFailure, sessionOkFields, extensionIsManaging, EXTENSION_GRACE_MS, SESSION_ALERT_FIELDS: FIELDS };
