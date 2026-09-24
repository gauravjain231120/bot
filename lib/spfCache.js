const { getDb } = require('./db');
const { fetchSpfTickets } = require('./myntra');

// Keeps the SPF page from re-walking Myntra on every view.
//
// Before: opening the SPF page paginated every ticket (one call per 50), and
// revealing Paid fetched ONE claim-detail call per paid ticket (~140, 8 at a
// time) — every time, the heaviest burst the bot ever sent Myntra.
//
// Now:
//  - The ticket list is cached for TICKETS_TTL_MS (settings/cache_spf_tickets).
//    The page's Refresh button (fresh: true) re-fetches it.
//  - A PAID claim never changes once Myntra has paid it, so each resolved paid
//    claim is stored for good (collection spfPaidClaims, _id = ticketId) and
//    only paid tickets not stored yet are fetched. Failed lookups aren't
//    stored, so they're retried next time. First reveal ~140 calls, after
//    that only newly paid tickets.
// The fake/wrong split (lib/spfPaid.js) is still recomputed against
// stock-manager on every reveal, so a re-grade there shows immediately.

const TICKETS_ID = 'cache_spf_tickets';
const TICKETS_TTL_MS = 15 * 60 * 1000;
const CLAIMS = 'spfPaidClaims';

async function loadSpfTickets(headers, { fresh = false } = {}) {
  const db = await getDb();
  const settings = db.collection('settings');
  if (!fresh) {
    const doc = await settings.findOne({ _id: TICKETS_ID });
    if (doc && Array.isArray(doc.tickets) && Date.now() - new Date(doc.at).getTime() < TICKETS_TTL_MS) {
      return { tickets: doc.tickets, at: doc.at, cached: true };
    }
  }
  const tickets = await fetchSpfTickets(headers);
  const at = new Date().toISOString();
  await settings
    .updateOne({ _id: TICKETS_ID }, { $set: { tickets, at } }, { upsert: true })
    .catch((err) => console.error('SPF ticket cache write failed:', err.message));
  return { tickets, at, cached: false };
}

// Store for resolved paid claims, handed to fetchSpfPaidClaims().
const paidClaimStore = {
  async get(ticketIds) {
    if (!ticketIds.length) return new Map();
    const db = await getDb();
    const docs = await db.collection(CLAIMS).find({ _id: { $in: ticketIds.map(String) } }).toArray();
    return new Map(docs.map(({ _id, savedAt, ...claim }) => [_id, claim]));
  },
  async save(claims) {
    if (!claims.length) return;
    try {
      const db = await getDb();
      const savedAt = new Date();
      await db.collection(CLAIMS).bulkWrite(
        claims.map((c) => ({
          updateOne: { filter: { _id: String(c.ticketId) }, update: { $set: { ...c, savedAt } }, upsert: true },
        }))
      );
    } catch (err) {
      console.error('SPF paid-claim cache write failed:', err.message);
    }
  },
};

module.exports = { loadSpfTickets, paidClaimStore, TICKETS_TTL_MS };
