const { getDb } = require('./db');

// Which Amazon merchant-fulfilled programs to search on this check.
//
// Every check used to search BOTH Easy Ship and self-ship — half of all
// Amazon traffic (~576 calls/day between the order and cancellation checks).
// Verified live 2026-09-23: self-ship had 0 orders in the last 365 days vs
// 704 on Easy Ship. So:
//  - Easy Ship: every check, exactly as before.
//  - Self-ship: at most every SELF_SHIP_EVERY_MS per check type — and back to
//    EVERY check for a day as soon as it ever returns anything, so a seller
//    who starts using it gets the normal cadence straight away.
// Worst case: the very first self-ship order after a long quiet spell is
// seen up to 30 minutes later than it would have been. State lives in
// settings/_id:'amazon_programs'. Never throws — on any problem it checks
// both, the old behaviour.
const SELF_SHIP_EVERY_MS = 30 * 60 * 1000;
const ACTIVE_FOR_MS = 24 * 60 * 60 * 1000;
const DOC_ID = 'amazon_programs';

async function programsToCheck(kind) {
  try {
    const db = await getDb();
    const doc = (await db.collection('settings').findOne({ _id: DOC_ID })) || {};
    const now = Date.now();
    const lastSeen = doc.selfshipLastSeenAt ? new Date(doc.selfshipLastSeenAt).getTime() : 0;
    const lastChecked = doc[`selfshipLastChecked_${kind}`] ? new Date(doc[`selfshipLastChecked_${kind}`]).getTime() : 0;
    const active = now - lastSeen < ACTIVE_FOR_MS;
    return active || now - lastChecked >= SELF_SHIP_EVERY_MS ? ['easyship', 'selfship'] : ['easyship'];
  } catch {
    return ['easyship', 'selfship'];
  }
}

// After a check: remember when self-ship was last searched, and whether it
// had anything (which keeps it on every check for the next day).
async function noteProgramsChecked(kind, byProgram) {
  try {
    if (!byProgram || !('selfship' in byProgram)) return;
    const now = new Date().toISOString();
    const set = { [`selfshipLastChecked_${kind}`]: now };
    if ((byProgram.selfship || []).length) set.selfshipLastSeenAt = now;
    const db = await getDb();
    await db.collection('settings').updateOne({ _id: DOC_ID }, { $set: set }, { upsert: true });
  } catch (err) {
    console.error('amazon program state not saved:', err.message);
  }
}

module.exports = { programsToCheck, noteProgramsChecked };
