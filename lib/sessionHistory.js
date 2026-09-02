const { getDb } = require('./db');

const COLLECTION = 'sessionHistory';

// Called whenever a fresh session is pasted. Closes out any still-open entry
// for this marketplace first (treated as "replaced" rather than "expired" —
// we never actually observed it fail) so entries never overlap, then starts
// a new one.
async function recordSessionCaptured(marketplace) {
  const db = await getDb();
  const col = db.collection(COLLECTION);
  const now = new Date();

  const open = await col.findOne({ marketplace, expiredAt: null });
  if (open) {
    await col.updateOne(
      { _id: open._id },
      { $set: { expiredAt: now, durationMs: now - open.capturedAt, endedBy: 'replaced' } }
    );
  }

  await col.insertOne({ marketplace, capturedAt: now, expiredAt: null, durationMs: null, endedBy: null });
}

// Called when a session is actually detected as expired (a real 401/403, or
// Myntra's soft 200-with-embedded-error). Naturally a no-op if there's no
// open entry — e.g. a repeat failure on the same already-recorded expiry —
// so callers can call this on every failed check without double-counting.
async function recordSessionExpired(marketplace) {
  const db = await getDb();
  const col = db.collection(COLLECTION);
  const open = await col.findOne({ marketplace, expiredAt: null });
  if (!open) return;

  const now = new Date();
  await col.updateOne(
    { _id: open._id },
    { $set: { expiredAt: now, durationMs: now - open.capturedAt, endedBy: 'expired' } }
  );
}

async function listSessionHistory(limit = 200) {
  const db = await getDb();
  const col = db.collection(COLLECTION);
  return col.find({}).sort({ capturedAt: -1 }).limit(limit).toArray();
}

module.exports = { recordSessionCaptured, recordSessionExpired, listSessionHistory };
