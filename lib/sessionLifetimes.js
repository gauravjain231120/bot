const { getDb } = require('./db');

// One row per session death — so "how long do sessions actually last?" has a
// real answer instead of a guess (the old session-history feature was removed
// 2026-09-22). Written only when a session is first seen failing (the same
// moment the once-per-outage "session expired" alert fires), so at most one
// row per outage. Never throws.
const KEEP = 500;

async function recordSessionDeath(marketplace, reason) {
  try {
    const db = await getDb();
    const sessionDoc = await db.collection('settings').findOne(
      { _id: marketplace === 'amazon' ? 'session_amazon' : 'session' },
      { projection: { capturedAt: 1, source: 1, cookiesRolledAt: 1 } },
    );
    const diedAt = new Date();
    const capturedAt = sessionDoc && sessionDoc.capturedAt ? new Date(sessionDoc.capturedAt) : null;
    const col = db.collection('sessionLifetimes');
    await col.insertOne({
      marketplace,
      capturedAt,
      source: (sessionDoc && sessionDoc.source) || null,
      lastCookieRefreshAt: sessionDoc && sessionDoc.cookiesRolledAt ? new Date(sessionDoc.cookiesRolledAt) : null,
      diedAt,
      lifetimeMinutes: capturedAt ? Math.round((diedAt - capturedAt) / 60000) : null,
      reason: String(reason || '').slice(0, 300),
    });
    const extra = (await col.estimatedDocumentCount()) - KEEP;
    if (extra > 0) {
      const old = await col.find({}).sort({ diedAt: 1 }).limit(extra).project({ _id: 1 }).toArray();
      await col.deleteMany({ _id: { $in: old.map((d) => d._id) } });
    }
  } catch (err) {
    console.error('session lifetime log failed:', err.message);
  }
}

module.exports = { recordSessionDeath };
