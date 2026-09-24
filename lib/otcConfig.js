// A tiny, dedicated settings accessor for one preference: who the OTC
// success alert (§19) goes to. Same "own settings doc" pattern as
// lib/monitorState.js's running flag — kept separate from lib/recipients.js
// since this isn't a per-person role, it's a single global routing choice.
const VALID_SCOPES = ['OWNER', 'BROADCAST'];
const DEFAULT_SCOPE = 'OWNER'; // matches the feature's original, unconfigurable behavior

async function getOtcRecipientScope(db) {
  const doc = await db.collection('settings').findOne({ _id: 'otc_config' });
  const scope = doc && doc.recipientScope;
  return VALID_SCOPES.includes(scope) ? scope : DEFAULT_SCOPE;
}

async function setOtcRecipientScope(db, scope) {
  if (!VALID_SCOPES.includes(scope)) throw new Error(`Invalid scope: ${scope}`);
  await db.collection('settings').updateOne({ _id: 'otc_config' }, { $set: { recipientScope: scope } }, { upsert: true });
}

// ---- The daily check window (India time) ----
// When the OTC check runs each day, as "HH:MM" 24-hour IST — set from the
// dashboard (Owner only). Default 12:00–13:00, the courier's usual midday
// visit. Start must be before end on the same day (no overnight window), at
// least MIN_WINDOW_MIN long and at most MAX_WINDOW_MIN — the check polls
// Myntra every ~2 min inside the window until a code shows up, so a very long
// window would mean a lot of calls on a day no code comes.
const DEFAULT_WINDOW = { start: '12:00', end: '13:00' };
const MIN_WINDOW_MIN = 5;
const MAX_WINDOW_MIN = 8 * 60;
const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

const toMinutes = (t) => {
  const m = TIME_RE.exec(String(t || ''));
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
};

/** Error text if start/end aren't a usable window, else null. */
function validateOtcWindow(start, end) {
  const a = toMinutes(start);
  const b = toMinutes(end);
  if (a == null || b == null) return 'Times must be HH:MM (24-hour), e.g. 12:00 and 13:30.';
  if (b <= a) return 'End time must be later than start time (same day).';
  if (b - a < MIN_WINDOW_MIN) return `The window must be at least ${MIN_WINDOW_MIN} minutes.`;
  if (b - a > MAX_WINDOW_MIN) return `The window can be at most ${MAX_WINDOW_MIN / 60} hours (it calls Myntra every ~2 min inside it).`;
  return null;
}

function shapeWindow(start, end, extra = {}) {
  return { start, end, startMin: toMinutes(start), endMin: toMinutes(end), ...extra };
}

async function getOtcWindow(db) {
  const doc = await db.collection('settings').findOne({ _id: 'otc_config' }, { projection: { window: 1 } });
  const w = doc && doc.window;
  if (w && !validateOtcWindow(w.start, w.end)) {
    return shapeWindow(w.start, w.end, { updatedAt: w.updatedAt || null, updatedBy: w.updatedBy || null });
  }
  return shapeWindow(DEFAULT_WINDOW.start, DEFAULT_WINDOW.end, { isDefault: true });
}

async function setOtcWindow(db, start, end, updatedBy) {
  const error = validateOtcWindow(start, end);
  if (error) throw new Error(error);
  const window = { start, end, updatedAt: new Date().toISOString(), updatedBy: updatedBy || null };
  await db.collection('settings').updateOne({ _id: 'otc_config' }, { $set: { window } }, { upsert: true });
  return shapeWindow(start, end, { updatedAt: window.updatedAt, updatedBy: window.updatedBy });
}

module.exports = {
  VALID_SCOPES,
  DEFAULT_SCOPE,
  getOtcRecipientScope,
  setOtcRecipientScope,
  DEFAULT_WINDOW,
  MIN_WINDOW_MIN,
  MAX_WINDOW_MIN,
  validateOtcWindow,
  getOtcWindow,
  setOtcWindow,
};
