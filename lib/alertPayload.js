const { sendTelegramMessage, sendTelegramPhoto, sendTelegramMediaGroup } = require('./telegram');
const { addToReadyToShip } = require('./readyToShip');
const { escapeHtml } = require('./html');
const { badgePhotos } = require('./photoBadge');

// A built alert — its text and photo URLs — as stored on the seen-order
// record. When Telegram doesn't take it, the next check sends this same
// payload again instead of rebuilding it: no marketplace call, no second
// Ready to Ship reservation.

// Telegram caps a media group (album) at 10 photos.
const MAX_ALBUM_PHOTOS = 10;

// `builtAt`: when the order's data was read (what the payload reflects).
// `cancelled`: { SUFFIX: n } units already cancelled in that data — left out
// of this alert, so the cancel sweep never announces them either.
// `unreserved`: the Ready to Ship adds that failed while building it (their
// exact addToReadyToShip arguments) — retried before every resend.
function makePayload(text, photos = [], builtAt = new Date(), cancelled = {}, unreserved = []) {
  return { text: String(text || ''), photos: photos.filter(Boolean).slice(0, MAX_ALBUM_PHOTOS), builtAt, cancelled, unreserved };
}

/**
 * Before a stored alert is resent: try again the reservations that failed
 * when it was built (addToReadyToShip skips what's already queued, so a retry
 * never reserves twice). One still failing tells the owner — once per error
 * (`notifiedError`), not on every resend. Returns the ones still failing.
 */
async function retryReservations(payload, alertQueueFailure) {
  const still = [];
  for (const entry of payload.unreserved || []) {
    const { notifiedError, ...add } = entry;
    const r = await addToReadyToShip(add);
    if (r.ok) continue;
    if (r.error !== notifiedError) await alertQueueFailure(add.orderId, `SKU <code>${escapeHtml(add.sku)}</code>: ${escapeHtml(r.error)}`);
    still.push({ ...add, notifiedError: r.error });
  }
  return still;
}

// A stored alert whose order changed since, sent anyway (it couldn't be
// rebuilt): says so on top.
function withStaleWarning(payload) {
  return {
    ...payload,
    text: `⚠️ <b>Part of this order was cancelled after this alert was prepared</b> — check it on the marketplace (and in Ready to Ship) before packing.\n\n${payload.text}`,
  };
}

const cancelledOf = (units) => Object.fromEntries(Object.entries(units || {}).filter(([, u]) => u.cancelledAtAlert > 0).map(([k, u]) => [k, u.cancelledAtAlert]));

// One message: text only, one photo with the text as its caption, or an
// album with the text on the first photo (the only caption shown inline).
// `marketplace` ('myntra' / 'amazon'): its logo goes on the photos' top-left
// corner (lib/photoBadge.js — a photo it can't draw on goes as it was).
async function sendPayload({ text, photos = [], engineMode }, marketplace = null) {
  if (photos.length === 0) return sendTelegramMessage(text, engineMode);
  const shown = await badgePhotos(photos.slice(0, MAX_ALBUM_PHOTOS), marketplace);
  if (shown.length === 1) return sendTelegramPhoto(shown[0], text, engineMode);
  return sendTelegramMediaGroup(shown.map((photo, i) => ({ photo, caption: i === 0 ? text : undefined })), engineMode);
}

module.exports = { makePayload, sendPayload, cancelledOf, retryReservations, withStaleWarning, MAX_ALBUM_PHOTOS };
