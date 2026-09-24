const { getDb } = require('./db');

// The scan pages look a return up (Myntra: 2 calls, Amazon: 1–3) and, seconds
// later, "Add to Return" needs the same answer again — whether it's a customer
// return or an RTO, which is Owner-only so the browser's copy can't be trusted
// (lib/returnTypeServer.js). That used to repeat the whole marketplace lookup
// per add. Now the scan's server-side result is kept here briefly and the add
// reuses it — half the marketplace calls per return, same answer. Server-side
// only; never sent to a browser. Never throws (a miss just means the live
// lookup runs, exactly as before).
const TTL_MS = 30 * 60 * 1000;
const COLLECTION = 'returnLookupCache';

const keyFor = (kind, trackingId) => `${kind}:${String(trackingId || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '')}`;

/** entries: [{ sku?, returnType }] — one per item the scan found. */
async function rememberReturnLookup(kind, trackingIds, entries) {
  try {
    const ids = [...new Set((trackingIds || []).filter(Boolean).map((t) => keyFor(kind, t)))].filter((k) => !k.endsWith(':'));
    if (!ids.length) return;
    const db = await getDb();
    const col = db.collection(COLLECTION);
    const at = new Date();
    await col.bulkWrite(ids.map((_id) => ({ updateOne: { filter: { _id }, update: { $set: { entries, at } }, upsert: true } })));
    await col.deleteMany({ at: { $lt: new Date(Date.now() - 24 * 60 * 60 * 1000) } });
  } catch (err) {
    console.error('return lookup cache write failed:', err.message);
  }
}

/** The entries saved by a recent scan of this tracking id, or null. */
async function recallReturnLookup(kind, trackingId) {
  try {
    if (!trackingId) return null;
    const db = await getDb();
    const doc = await db.collection(COLLECTION).findOne({ _id: keyFor(kind, trackingId) });
    if (!doc || !doc.at || Date.now() - new Date(doc.at).getTime() > TTL_MS) return null;
    return Array.isArray(doc.entries) ? doc.entries : null;
  } catch (err) {
    console.error('return lookup cache read failed:', err.message);
    return null;
  }
}

module.exports = { rememberReturnLookup, recallReturnLookup };
