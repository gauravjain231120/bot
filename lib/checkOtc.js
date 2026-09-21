const { getDb } = require('./db');
const { fetchOtc } = require('./myntra');
const { sendOwnerAlert } = require('./telegram');

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

function istNow() {
  return new Date(Date.now() + IST_OFFSET_MS);
}

// "YYYY-MM-DD" for the current IST calendar day — the dedupe key, so a new
// day always gets a fresh chance to alert without anything having to reset it.
function istDateKey(d) {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

// The pickup/return OTC only matters for the courier's actual midday visit —
// polling outside 12:00–13:00 IST would just burn API calls (and session
// requests that can expire) for a code that's never live then anyway. This is
// checked here, not just relied on from the external scheduler's own
// schedule, so a misconfigured or stray trigger can never cause off-window
// polling — same "guard it here too" pattern as isAuthorizedCron() in the
// sister project.
function withinWindow(d) {
  return d.getUTCHours() === 12; // already IST-shifted by istNow()
}

function otcLine(label, value) {
  return `${label}: <b>${value || '—'}</b>`;
}

/**
 * Runs every ~5 minutes, 12:00–13:00 IST only (route + this function both
 * guard the window). Reads the courier handover code for both trip types
 * (PICKUP, RETURN) and both couriers (MYS, MYE) in one poll. The moment any
 * of those four is no longer null, sends ONE Telegram message with all four
 * lines (blank for whichever are still null) to whoever has Owner role only —
 * not the full broadcast list, and not silent — then marks today as alerted
 * so the rest of the window is skipped, no repeat pings, no more API calls
 * against the Myntra session for the rest of the hour.
 */
async function runCheckOtc() {
  const now = istNow();
  if (!withinWindow(now)) {
    return { skipped: true, reason: 'outside 12–1pm IST window' };
  }

  const db = await getDb();
  const settings = db.collection('settings');
  const todayKey = istDateKey(now);

  const stateDoc = await settings.findOne({ _id: 'otc_status' });
  if (stateDoc && stateDoc.alertedDate === todayKey) {
    return { skipped: true, reason: 'already alerted today' };
  }

  const sessionDoc = await settings.findOne({ _id: 'session' });
  if (!sessionDoc || !sessionDoc.headers) {
    throw new Error('No Myntra session saved yet — paste one on the admin page.');
  }
  const headers = sessionDoc.headers;

  const [pickup, ret] = await Promise.all([fetchOtc('PICKUP', headers), fetchOtc('RETURN', headers)]);

  const values = {
    pickupMys: pickup.MYS || null,
    pickupMye: pickup.MYE || null,
    returnMys: ret.MYS || null,
    returnMye: ret.MYE || null,
  };

  const anyFound = Object.values(values).some(Boolean);
  if (!anyFound) {
    return { alerted: false, values };
  }

  const message =
    `🔑 <b>Pickup / Return OTC</b>\n\n` +
    `${otcLine('Pickup MYS', values.pickupMys)}\n` +
    `${otcLine('Pickup MYE', values.pickupMye)}\n` +
    `${otcLine('Return MYS', values.returnMys)}\n` +
    `${otcLine('Return MYE', values.returnMye)}`;

  await sendOwnerAlert(message);

  await settings.updateOne(
    { _id: 'otc_status' },
    { $set: { alertedDate: todayKey, alertedAt: new Date(), values } },
    { upsert: true },
  );

  return { alerted: true, values };
}

module.exports = { runCheckOtc };
