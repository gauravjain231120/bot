const { getDb } = require('./db');
const { fetchOtc, isSessionRejected } = require('./myntra');
const { sendOwnerAlert, sendTelegramMessage } = require('./telegram');
const { getOtcRecipientScope } = require('./otcConfig');
const { formatOtcStatus } = require('./telegramCommands');

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

/**
 * Runs every ~2 minutes, 12:00–13:00 IST only (route + this function both
 * guard the window). Reads the courier handover code for both trip types
 * (PICKUP, RETURN) and both couriers (MYS, MYE) in one poll. The moment any
 * of those four is no longer null, sends ONE Telegram message with all four
 * lines (blank for whichever are still null) — not silent — then marks today
 * as alerted so the rest of the window is skipped, no repeat pings, no more
 * API calls against the Myntra session for the rest of the hour.
 *
 * Who that success message goes to is configurable (`getOtcRecipientScope()`,
 * dashboard-managed, §19): **Owner** scope (the default) sends to Owner role
 * only; **Broadcast** scope sends to everyone in the recipients list (Owner
 * included — Owner always gets every alert regardless of this setting).
 * Session-problem alerts below are deliberately NOT affected by this scope —
 * they always go to Owner only, since fixing a dead session isn't actionable
 * for a Viewer.
 *
 * A missing or expired Myntra session during the window gets its own,
 * separately-deduped Owner alert (`alertOtcSessionProblem`) instead of
 * failing silently — this is exactly the hour the code is time-sensitive, so
 * "the check is broken and nobody knows" would defeat the point of the
 * feature entirely.
 */
// Session problems (missing or expired) get exactly one Owner alert per IST
// day, same dedup shape as the success side (`alertedDate`) — a dead session
// right when the courier's code matters is the one time this genuinely needs
// a human, but repeating it every 2 minutes for the rest of the hour would
// just be noise, not signal.
async function alertOtcSessionProblem(settings, stateDoc, todayKey, message) {
  if (stateDoc && stateDoc.errorAlertedDate === todayKey) return;
  await sendOwnerAlert(message).catch((err) => console.error('OTC session-problem alert failed:', err.message));
  await settings.updateOne({ _id: 'otc_status' }, { $set: { errorAlertedDate: todayKey } }, { upsert: true });
}

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
    await alertOtcSessionProblem(
      settings,
      stateDoc,
      todayKey,
      '⚠️ <b>OTC check: no Myntra session saved</b>\nPaste one on the admin page to check pickup/return codes today.',
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
      await alertOtcSessionProblem(
        settings,
        stateDoc,
        todayKey,
        '⚠️ <b>OTC check failed — Myntra session expired</b>\nPaste a fresh session on the admin page to keep checking pickup/return codes today.',
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

  const anyFound = Object.values(values).some(Boolean);
  if (!anyFound) {
    return { alerted: false, values };
  }

  const message = formatOtcStatus(values);

  const scope = await getOtcRecipientScope(db);
  if (scope === 'BROADCAST') {
    await sendTelegramMessage(message);
  } else {
    await sendOwnerAlert(message);
  }

  await settings.updateOne(
    { _id: 'otc_status' },
    { $set: { alertedDate: todayKey, alertedAt: new Date(), values } },
    { upsert: true },
  );

  return { alerted: true, values };
}

// Minutes until the 12:00–13:00 IST window next changes state — 13:00 if
// currently inside it, the next 12:00 (today or tomorrow) if outside it.
// Pure clock math, no DB — backs the dashboard's countdown display only.
function minutesUntilWindowChange(d) {
  const hour = d.getUTCHours();
  const minute = d.getUTCMinutes();
  if (hour === 12) {
    return (60 - minute) % 60 || 60;
  }
  const minutesNow = hour * 60 + minute;
  const targetMinutes = 12 * 60;
  if (minutesNow < targetMinutes) return targetMinutes - minutesNow;
  return 24 * 60 - minutesNow + targetMinutes;
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
  const stateDoc = await db.collection('settings').findOne({ _id: 'otc_status' });

  const alertedToday = Boolean(stateDoc && stateDoc.alertedDate === todayKey);
  const clearedToday = Boolean(stateDoc && stateDoc.clearedDate === todayKey);

  return {
    todayKey,
    windowActive: withinWindow(now),
    minutesToWindowChange: minutesUntilWindowChange(now),
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

module.exports = { runCheckOtc, getOtcDisplayStatus, clearOtcDisplay };
