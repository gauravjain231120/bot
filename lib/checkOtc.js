const { getDb } = require('./db');
const { fetchOtc, isSessionRejected } = require('./myntra');
const { sendOwnerAlert, sendTelegramMessage } = require('./telegram');
const { getOtcRecipientScope, getOtcWindow } = require('./otcConfig');
const { formatOtcStatus } = require('./telegramCommands');
const { noteSessionFailure } = require('./sessionAlerts');

// After the first code is sent, the rest of the window is still watched for
// codes that appear later (e.g. RETURN after PICKUP), but only this often —
// and not at all once all four are in.
const FOLLOW_UP_EVERY_MS = 10 * 60 * 1000;
const OTC_KEYS = ['pickupMys', 'pickupMye', 'returnMys', 'returnMye'];

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

function istNow() {
  return new Date(Date.now() + IST_OFFSET_MS);
}

// "YYYY-MM-DD" for the current IST calendar day — the dedupe key, so a new
// day always gets a fresh chance to alert without anything having to reset it.
function istDateKey(d) {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

// The pickup/return OTC only matters around the courier's visit — polling
// outside the check window would just burn API calls (and session requests
// that can expire) for a code that's never live then anyway. The window is
// set on the dashboard in India time (lib/otcConfig.js, default 12:00–13:00
// IST; start inclusive, end exclusive). This is checked here, not just relied
// on from the external scheduler's own schedule, so a misconfigured or stray
// trigger can never cause off-window polling.
function istMinutes(d) {
  return d.getUTCHours() * 60 + d.getUTCMinutes(); // already IST-shifted by istNow()
}

function withinWindow(d, win) {
  const m = istMinutes(d);
  return m >= win.startMin && m < win.endMin;
}

/**
 * Runs every ~2 minutes, inside the dashboard-set IST check window only
 * (default 12:00–13:00; route + this function both guard the window).
 * Reads the courier handover code for both trip types (PICKUP, RETURN) and
 * both couriers (MYS, MYE) in one poll. The moment any of those four is no
 * longer null, sends ONE Telegram message with all four lines (blank for
 * whichever are still null) — not silent. After that it looks again every
 * 10 minutes (not every 2) until all four are in or the window closes, and
 * sends an update only if a NEW code turned up — a RETURN code that appears
 * after the PICKUP one used to be never sent at all.
 *
 * Who that message goes to is configurable (`getOtcRecipientScope()`,
 * dashboard-managed, §19): **Owner** scope (the default) sends to Owner role
 * only; **Broadcast** scope sends to everyone in the recipients list (Owner
 * included — Owner always gets every alert regardless of this setting).
 *
 * A missing or expired Myntra session goes through the shared once-per-outage
 * session alert (lib/sessionAlerts.js — waits for the extension to restore
 * it first), not a separate OTC-only alert. Nothing is marked done unless the
 * message actually reached someone.
 */
async function runCheckOtc() {
  const now = istNow();
  const db = await getDb();
  const settings = db.collection('settings');
  const win = await getOtcWindow(db);
  if (!withinWindow(now, win)) {
    return { skipped: true, reason: `outside the ${win.start}–${win.end} IST window` };
  }

  const todayKey = istDateKey(now);

  const stateDoc = await settings.findOne({ _id: 'otc_status' });
  const alertedToday = stateDoc && stateDoc.alertedDate === todayKey;
  if (stateDoc && stateDoc.completeDate === todayKey) {
    return { skipped: true, reason: 'all codes already sent today' };
  }
  if (alertedToday && stateDoc.lastPollAt && Date.now() - new Date(stateDoc.lastPollAt).getTime() < FOLLOW_UP_EVERY_MS) {
    return { skipped: true, reason: 'sent today — next look for new codes in a few minutes' };
  }

  const sessionDoc = await settings.findOne({ _id: 'session' });
  if (!sessionDoc || !sessionDoc.headers) {
    await noteSessionFailure(
      settings,
      'myntra',
      '⚠️ Myntra session missing — pickup/return codes (OTC) can\'t be checked. Paste one on the admin page (or let the browser extension sync one).',
      { sessionDoc: null },
    );
    throw new Error('No Myntra session saved yet — paste one on the admin page.');
  }
  const headers = sessionDoc.headers;

  let pickup;
  let ret;
  try {
    [pickup, ret] = await Promise.all([fetchOtc('PICKUP', headers), fetchOtc('RETURN', headers)]);
  } catch (err) {
    const status = err.response && err.response.status;
    if (isSessionRejected(err)) {
      await noteSessionFailure(
        settings,
        'myntra',
        '⚠️ Myntra session expired — pickup/return codes (OTC) can\'t be checked. Paste a fresh session on the admin page.',
        { sessionDoc },
      );
    }
    const wrapped = new Error(`OTC check failed${status ? ` (HTTP ${status})` : ''}: ${err.message}`);
    wrapped.status = status;
    throw wrapped;
  }

  const values = {
    pickupMys: pickup.MYS || null,
    pickupMye: pickup.MYE || null,
    returnMys: ret.MYS || null,
    returnMye: ret.MYE || null,
  };

  await settings.updateOne({ _id: 'otc_status' }, { $set: { lastPollAt: new Date() } }, { upsert: true });
  const anyFound = OTC_KEYS.some((k) => values[k]);
  if (!anyFound) {
    return { alerted: false, values };
  }
  // Codes already sent today are kept (a code never "disappears" from the message).
  const before = alertedToday ? stateDoc.values || {} : {};
  const merged = Object.fromEntries(OTC_KEYS.map((k) => [k, values[k] || before[k] || null]));
  const fresh = OTC_KEYS.filter((k) => merged[k] && merged[k] !== before[k]);
  const complete = OTC_KEYS.every((k) => merged[k]);
  if (!fresh.length) {
    if (complete) await settings.updateOne({ _id: 'otc_status' }, { $set: { completeDate: todayKey } }, { upsert: true });
    return { alerted: false, values: merged };
  }

  const message = alertedToday ? `🔄 <b>Update</b> — new code${fresh.length > 1 ? 's' : ''}\n${formatOtcStatus(merged)}` : formatOtcStatus(merged);
  const scope = await getOtcRecipientScope(db);
  const res = scope === 'BROADCAST' ? await sendTelegramMessage(message) : await sendOwnerAlert(message);
  if (!res || res.sent === 0) {
    // Nobody got it — try again on the next poll instead of marking it sent.
    await settings.updateOne({ _id: 'otc_status' }, { $set: { lastPollAt: null } });
    return { alerted: false, values: merged, error: 'not delivered' };
  }

  await settings.updateOne(
    { _id: 'otc_status' },
    { $set: { alertedDate: todayKey, alertedAt: alertedToday ? stateDoc.alertedAt : new Date(), values: merged, ...(complete ? { completeDate: todayKey } : {}) } },
    { upsert: true },
  );

  return { alerted: true, values: merged };
}

// Minutes until the check window next changes state — its end if currently
// inside it, else its next start (today or tomorrow). Pure clock math —
// backs the dashboard's countdown display only.
function minutesUntilWindowChange(d, win) {
  const m = istMinutes(d);
  if (m >= win.startMin && m < win.endMin) return win.endMin - m;
  if (m < win.startMin) return win.startMin - m;
  return 24 * 60 - m + win.startMin;
}

/**
 * Everything the dashboard needs to render the OTC card: whether the window
 * is active right now, minutes until it flips (opens/closes), and today's
 * result — the codes found (if any, and not manually cleared) or null.
 * Read-only, no side effects, safe to call on every dashboard poll.
 */
async function getOtcDisplayStatus() {
  const now = istNow();
  const todayKey = istDateKey(now);
  const db = await getDb();
  const [stateDoc, win] = await Promise.all([db.collection('settings').findOne({ _id: 'otc_status' }), getOtcWindow(db)]);

  const alertedToday = Boolean(stateDoc && stateDoc.alertedDate === todayKey);
  const clearedToday = Boolean(stateDoc && stateDoc.clearedDate === todayKey);

  return {
    todayKey,
    windowActive: withinWindow(now, win),
    minutesToWindowChange: minutesUntilWindowChange(now, win),
    window: { start: win.start, end: win.end },
    alertedToday,
    clearedToday,
    values: alertedToday && !clearedToday ? stateDoc.values : null,
    alertedAt: alertedToday ? stateDoc.alertedAt : null,
  };
}

/**
 * Dashboard "Clear" action — hides today's found code(s) from the display by
 * setting `clearedDate`, deliberately WITHOUT touching `alertedDate`. That
 * separation is the whole point: the poller's "already alerted today, stop
 * calling Myntra" gate is `alertedDate` alone, so clearing the display can
 * never restart polling for the rest of the day. Resets naturally tomorrow,
 * same as every other date-keyed flag in this file.
 */
async function clearOtcDisplay() {
  const todayKey = istDateKey(istNow());
  const db = await getDb();
  await db.collection('settings').updateOne({ _id: 'otc_status' }, { $set: { clearedDate: todayKey } }, { upsert: true });
}

module.exports = { runCheckOtc, getOtcDisplayStatus, clearOtcDisplay, withinWindow, minutesUntilWindowChange };
