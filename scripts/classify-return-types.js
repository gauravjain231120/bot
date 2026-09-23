/**
 * One-off (2026-09-23), READ-ONLY: work out customer return vs RTO for every
 * RETURNED row already in stock-manager that doesn't have a `returnType` yet,
 * and write the answers to a JSON file. Nothing is written to any database —
 * stock-manager's scripts/apply-return-types.ts applies the file (dry run
 * first).
 *
 * Same rules the scan pages use going forward:
 *  - MYNTRA: fetchNewClaim(tracking) -> lib/myntra.js myntraReturnType()
 *    (return date/reason = CUSTOMER; orderStatus RTO/F = RTO).
 *  - AMAZON: lib/amazonScan.js lookupAmazonReturn — by tracking, else by the
 *    row's order id. A Manage Returns hit = CUSTOMER, a ReturnedToSeller /
 *    ReturningToSeller order = RTO. An RTO logged under its own return-label
 *    number (not linked to the order on Amazon) can't be told -> UNKNOWN.
 *  - Anything else (other platforms, no tracking/order id, lookup failed,
 *    conflicting answers) -> UNKNOWN.
 *
 *   node scripts/classify-return-types.js /path/to/out.json
 */
const fs = require('fs');
const path = require('path');

function loadEnvLocal() {
  const file = path.join(__dirname, '..', '.env.local');
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim();
    if (!(key in process.env)) process.env[key] = value;
  }
}
loadEnvLocal();

const axios = require('axios');
const { MongoClient } = require('mongodb');
const { getDb } = require('../lib/db');
const { lookupAmazonReturn } = require('../lib/amazonScan');

const OUT = process.argv[2];
const CONCURRENCY = 6;

function myntraType(claim) {
  if (claim.returnCreatedDate || claim.returnReason) return 'CUSTOMER';
  if (claim.orderStatus === 'RTO' || claim.orderStatus === 'F') return 'RTO';
  return 'UNKNOWN';
}

async function classifyMyntra(row, headers) {
  if (!row.trackingId) return { type: 'UNKNOWN', why: 'no tracking id' };
  const res = await axios.get(
    `https://partnersapi.myntrainfo.com/api/spf/fetchNewClaim?fetchAccio=true&id=${encodeURIComponent(row.trackingId)}`,
    { headers },
  );
  const claims = (res.data && res.data.data) || [];
  if (!claims.length) return { type: 'UNKNOWN', why: 'no Myntra record for this tracking id' };
  const types = [...new Set(claims.map(myntraType))];
  if (types.length > 1) return { type: 'UNKNOWN', why: `conflicting: ${types.join('/')}` };
  return { type: types[0], why: `Myntra orderStatus ${claims[0].orderStatus || '?'}` };
}

async function classifyAmazon(row, headers) {
  const attempts = [];
  if (row.trackingId) attempts.push(['tracking', row.trackingId]);
  if (row.orderId) attempts.push(['order', row.orderId]);
  if (!attempts.length) return { type: 'UNKNOWN', why: 'no tracking id or order id' };
  for (const [mode, value] of attempts) {
    const r = await lookupAmazonReturn(mode, value, headers);
    if (r.returns && r.returns.length) {
      const types = [...new Set(r.returns.map((x) => x.returnType))];
      if (types.length > 1) return { type: 'UNKNOWN', why: `conflicting: ${types.join('/')}` };
      return { type: types[0], why: `Amazon by ${mode}` };
    }
  }
  return { type: 'UNKNOWN', why: 'not found on Amazon (e.g. an RTO logged under its own return-label number)' };
}

async function main() {
  if (!OUT) throw new Error('usage: node scripts/classify-return-types.js /path/to/out.json');
  const db = await getDb();
  const myntraHeaders = ((await db.collection('settings').findOne({ _id: 'session' })) || {}).headers;
  const amazonHeaders = ((await db.collection('settings').findOne({ _id: 'session_amazon' })) || {}).headers;
  if (!myntraHeaders || !amazonHeaders) throw new Error('Myntra or Amazon session missing');

  const stock = await new MongoClient(process.env.STOCK_MONGODB_URI).connect();
  const rows = await stock
    .db()
    .collection('stockmovements')
    .find({ type: 'RETURNED', $or: [{ returnType: { $exists: false } }, { returnType: null }] })
    .project({ trackingId: 1, orderId: 1, channel: 1 })
    .toArray();
  console.log(`${rows.length} RETURNED rows without a return type`);

  const results = [];
  const queue = [...rows];
  async function worker() {
    while (queue.length) {
      const row = queue.shift();
      let r;
      try {
        if (row.channel === 'MYNTRA') r = await classifyMyntra(row, myntraHeaders);
        else if (row.channel === 'AMAZON') r = await classifyAmazon(row, amazonHeaders);
        else r = { type: 'UNKNOWN', why: `platform ${row.channel || 'none'}` };
      } catch (err) {
        // A session expiry would turn everything UNKNOWN — stop instead.
        if (err.sessionExpired || (err.response && [401, 403].includes(err.response.status))) throw err;
        r = { type: 'UNKNOWN', why: `lookup failed: ${err.message}` };
      }
      results.push({ id: String(row._id), channel: row.channel || null, trackingId: row.trackingId || null, orderId: row.orderId || null, ...r });
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  const tally = {};
  for (const r of results) {
    const k = `${r.channel || 'none'} ${r.type}`;
    tally[k] = (tally[k] || 0) + 1;
  }
  console.log(tally);
  fs.writeFileSync(OUT, JSON.stringify(results, null, 1));
  console.log(`wrote ${results.length} rows to ${OUT}`);
  await stock.close();
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
