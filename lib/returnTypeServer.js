const { getDb } = require('./db');
const { resolveReturnByTrackingId } = require('./myntra');
const { lookupAmazonReturn } = require('./amazonScan');

// Customer return vs RTO is Owner-only on the dashboard: the scan-page lookups
// strip it for anyone else, so the value a non-Owner's browser sends on "Add to
// Return" can't be trusted (or even present). The add routes work it out again
// here, server-side, from the same lookup the scan page used — so every return
// is stored with the right type no matter who added it.
//
// Falls back to the browser's value only for an Owner (who saw it), else
// UNKNOWN. Never throws — a failed lookup must not block logging the return.
const TYPES = ['CUSTOMER', 'RTO', 'UNKNOWN'];

const suffix = (sku) => (sku ? String(sku).slice(String(sku).indexOf('-') + 1).toUpperCase() : '');

async function sessionHeaders(id) {
  const db = await getDb();
  const doc = await db.collection('settings').findOne({ _id: id });
  return doc && doc.headers;
}

function fallback(clientType, isOwner) {
  return isOwner && TYPES.includes(clientType) ? clientType : 'UNKNOWN';
}

async function myntraReturnTypeFor(trackingId, sku, clientType, isOwner) {
  try {
    const headers = trackingId && (await sessionHeaders('session'));
    if (!headers) return fallback(clientType, isOwner);
    const items = await resolveReturnByTrackingId(trackingId, headers);
    const same = items.filter((i) => i.sku && suffix(i.sku) === suffix(sku));
    const pool = same.length ? same : items;
    const types = [...new Set(pool.map((i) => i.returnType).filter(Boolean))];
    return types.length === 1 ? types[0] : fallback(clientType, isOwner);
  } catch {
    return fallback(clientType, isOwner);
  }
}

async function amazonReturnTypeFor(trackingId, clientType, isOwner) {
  try {
    const headers = trackingId && (await sessionHeaders('session_amazon'));
    if (!headers) return fallback(clientType, isOwner);
    const r = await lookupAmazonReturn('tracking', trackingId, headers);
    const types = [...new Set(((r && r.returns) || []).map((x) => x.returnType).filter(Boolean))];
    return types.length === 1 ? types[0] : fallback(clientType, isOwner);
  } catch {
    return fallback(clientType, isOwner);
  }
}

module.exports = { myntraReturnTypeFor, amazonReturnTypeFor };
