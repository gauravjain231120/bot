const { MongoClient } = require('mongodb');

// Lazy + cached, same pattern as lib/db.js. This connects to a DIFFERENT
// database (stock-manager's own MongoDB) than the alert app's own storage.
function getStockClientPromise() {
  if (!global._stockMongoClientPromise) {
    const uri = process.env.STOCK_MONGODB_URI;
    if (!uri) throw new Error('STOCK_MONGODB_URI is not set');
    global._stockMongoClientPromise = new MongoClient(uri).connect();
  }
  return global._stockMongoClientPromise;
}

async function getStockDb() {
  const client = await getStockClientPromise();
  return client.db();
}

// Stock-manager tracks stock per (sku, locationCode) and only counts locations
// whose `kind` is SELLABLE toward what it publishes/shows as available (see its
// Location model + getProductGroups()) — QUARANTINE and DAMAGED stock is real
// on-hand inventory but never sellable. Mirrored here so alerts don't inflate
// "available" with damaged/quarantined units. Cached like the Mongo client
// above since sellable locations change rarely, if ever.
async function getSellableLocationCodes() {
  if (!global._sellableLocationCodesCache) {
    const db = await getStockDb();
    const locations = await db.collection('locations').find({ kind: 'SELLABLE' }).project({ code: 1 }).toArray();
    global._sellableLocationCodesCache = new Set(locations.map((l) => l.code));
  }
  return global._sellableLocationCodesCache;
}

// Mirrors stock-manager's own BUNDLE_STOCK_PREFIX (src/lib/constants.ts) — some
// product codes are bundles that draw physical stock from a different product's
// pool (e.g. "Halter with Palazzos" ships a "Halter Neck" top). Duplicated here
// rather than imported since this app intentionally never touches stock-manager's
// codebase directly — if stock-manager's own mapping changes, update this too.
const BUNDLE_CODE_MAP = {
  '012': '002', // Halter with Palazzos -> Halter Neck
  '013': '001', // V-Neck Kurti -> Co-ord Set
};

function resolveBundleCode(suffix) {
  const dashIdx = suffix.indexOf('-');
  if (dashIdx === -1) return suffix;
  const code = suffix.slice(0, dashIdx);
  const rest = suffix.slice(dashIdx);
  const mapped = BUNDLE_CODE_MAP[code];
  return mapped ? mapped + rest : suffix;
}

// Different marketplaces prefix the same underlying variant differently —
// RRC-010-CO-C-RED-M / RR-010-CO-C-RED-M / R-010-CO-C-RED-M are the same
// stock-manager variant. Compare only what's after the first "-", then resolve
// any bundle-product mapping on top of that.
function skuSuffix(sku) {
  if (!sku) return '';
  const idx = sku.indexOf('-');
  const raw = (idx === -1 ? sku : sku.slice(idx + 1)).trim().toUpperCase();
  return resolveBundleCode(raw);
}

// Category lookup wants the SKU's OWN product identity (e.g. a "012" order should
// show "Halter with Palazzos", its real category) — NOT the bundle-resolved stock
// pool that lookupStock uses (which would show "002"/"Halter Neck" instead), so
// this only strips the brand prefix, no bundle remapping.
function skuSuffixRaw(sku) {
  if (!sku) return '';
  const idx = sku.indexOf('-');
  return (idx === -1 ? sku : sku.slice(idx + 1)).trim().toUpperCase();
}

function classify(available) {
  if (available <= 0) return { label: 'OUT OF STOCK', level: 'out' };
  if (available <= 5) return { label: `Low (${available} left)`, level: 'low' };
  return { label: `${available} available`, level: 'ok' };
}

// Read-only lookup against stock-manager's live inventory (skustocks collection) —
// never writes. Returns null if the SKU has no match there, or if the lookup
// itself fails for any reason (a stock hiccup should never break the order alert).
async function lookupStock(sku) {
  const suffix = skuSuffix(sku);
  if (!suffix) return null;

  try {
    const db = await getStockDb();
    const sellable = await getSellableLocationCodes();
    const escaped = suffix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const docs = await db
      .collection('skustocks')
      .find({ sku: { $regex: `-${escaped}$`, $options: 'i' } })
      .project({ onHand: 1, reserved: 1, locationCode: 1 })
      .toArray();

    // docs.length === 0 means the SKU itself isn't tracked at all ("not found").
    // A SKU that only has DAMAGED/QUARANTINE docs is found but has 0 sellable
    // stock — that should classify as OUT OF STOCK, not "not found".
    if (docs.length === 0) return null;

    const sellableDocs = docs.filter((d) => sellable.has(d.locationCode));
    const onHand = sellableDocs.reduce((sum, d) => sum + (d.onHand || 0), 0);
    const reserved = sellableDocs.reduce((sum, d) => sum + (d.reserved || 0), 0);
    const available = onHand - reserved;

    return { onHand, reserved, available, ...classify(available) };
  } catch (err) {
    console.error('Stock lookup failed:', err.message);
    return null;
  }
}

// Telegram's HTML parse mode has no color support — bold + a colored circle
// emoji is the closest equivalent to "red bold out of stock" it can render.
//
// `stock === null` means lookupStock found no matching SKU at all (as opposed
// to a match with 0 available, which is the 'out' level below) — previously
// this rendered as an empty string, so the whole "Stock:" line just silently
// vanished from the caption with no way to tell "not tracked yet" apart from
// "the line failed to build." Spelling it out makes it obviously actionable
// (add the product in stock-manager) instead of looking like a bug.
//
// Exactly-zero available reads here as "Low (1 left)" instead of the red OUT
// OF STOCK line — a deliberate display-only choice for this outward alert
// text; `stock.level`/`available` themselves are untouched, so nothing else
// (the admin dashboard, Ready-to-Ship reservation, etc.) is affected. Actually
// negative available (oversold — more queued/reserved than physically in
// stock) is a worse signal than plain zero and must still show as OUT OF
// STOCK, not get papered over the same way.
function formatStockLine(stock) {
  if (!stock) return 'Stock: ⚠️ not found in stock manager\n';
  if (stock.level === 'out') {
    return stock.available === 0 ? `Stock: 🟡 Low (1 left)\n` : `Stock: 🔴 <b>OUT OF STOCK</b>\n`;
  }
  if (stock.level === 'low') return `Stock: 🟡 ${stock.label}\n`;
  return `Stock: ${stock.label}\n`;
}

// Read-only lookup against stock-manager's products collection — never writes.
// Returns null if the SKU has no match there, or if the lookup fails for any
// reason (never blocks the alert itself).
async function lookupCategory(sku) {
  const suffix = skuSuffixRaw(sku);
  if (!suffix) return null;

  try {
    const db = await getStockDb();
    const escaped = suffix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const doc = await db
      .collection('products')
      .findOne({ sku: { $regex: `-${escaped}$`, $options: 'i' } }, { projection: { category: 1 } });
    return (doc && doc.category) || null;
  } catch (err) {
    console.error('Category lookup failed:', err.message);
    return null;
  }
}

module.exports = { lookupStock, formatStockLine, lookupCategory };
