const { MongoClient } = require('mongodb');

// Lazy + cached, same pattern as lib/db.js (incl. never caching a FAILED
// connect — that used to make every stock/catalog lookup on a warm instance
// fail until it recycled, which showed up as "SKU isn't in the product
// catalog" for products that were). This connects to a DIFFERENT database
// (stock-manager's own MongoDB) than the alert app's own storage.
function getStockClientPromise() {
  if (!global._stockMongoClientPromise) {
    const uri = process.env.STOCK_MONGODB_URI;
    if (!uri) throw new Error('STOCK_MONGODB_URI is not set');
    global._stockMongoClientPromise = new MongoClient(uri, { serverSelectionTimeoutMS: 8000, connectTimeoutMS: 8000 })
      .connect()
      .catch((err) => {
        global._stockMongoClientPromise = null;
        throw err;
      });
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
    const locations = await withStockDb((db) => db.collection('locations').find({ kind: 'SELLABLE' }).project({ code: 1 }).toArray());
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

// What a stock line says when stock-manager couldn't be read at all — kept
// apart from "not found" (null) so an unreachable database is never reported
// as a missing product.
const STOCK_UNAVAILABLE = { unavailable: true, level: 'unknown', label: "couldn't check stock-manager" };

// One read of stock-manager's database, retried once after a short pause — a
// pooled connection that went stale (or a first connect that failed, see
// getStockClientPromise) almost always works on the second try.
async function withStockDb(fn) {
  try {
    return await fn(await getStockDb());
  } catch (err) {
    console.error('Stock-manager read failed, retrying once:', err.message);
    await new Promise((r) => setTimeout(r, 400));
    return fn(await getStockDb());
  }
}

// The catalog, indexed for SKU resolution: exact SKU, brand-prefix-free
// suffix (RRC-/RR-/R- are the same variant), category, active flag, and
// stock-manager's own per-variant "shares stock with" links (Products page —
// 90+ bundle variants use it). Cached briefly: it's a few hundred small docs,
// and every alert / dashboard refresh needs it.
const CATALOG_TTL_MS = 60 * 1000;

async function loadCatalog({ fresh = false } = {}) {
  const cached = global._stockCatalogCache;
  if (!fresh && cached && Date.now() - cached.at < CATALOG_TTL_MS) return cached;
  const docs = await withStockDb((db) =>
    db.collection('products').find({}, { projection: { sku: 1, name: 1, category: 1, active: 1, sharesStockWith: 1 } }).toArray(),
  );
  const bySku = new Map();
  const bySuffix = new Map();
  for (const d of docs) {
    if (!d.sku) continue;
    bySku.set(d.sku, d);
    const key = skuSuffixRaw(d.sku);
    if (!bySuffix.has(key)) bySuffix.set(key, []);
    bySuffix.get(key).push(d);
  }
  const catalog = { at: Date.now(), bySku, bySuffix };
  global._stockCatalogCache = catalog;
  return catalog;
}

// A marketplace SKU -> the catalog product it is: exact first, then by suffix
// (active products preferred). `activeOnly` = only ever an active product.
function findProduct(catalog, sku, { activeOnly = false } = {}) {
  const exact = catalog.bySku.get(String(sku || '').trim().toUpperCase());
  if (exact && (!activeOnly || exact.active)) return exact;
  const candidates = catalog.bySuffix.get(skuSuffixRaw(sku)) || [];
  return candidates.find((d) => d.active) || (activeOnly ? null : candidates[0]) || null;
}

// The SKU whose physical stock `sku` uses — its own, unless stock-manager
// links it to another variant's pile (followed along a chain, loop-safe,
// exactly like stock-manager's stockSkuFor). Unknown SKUs fall back to the
// old hardcoded bundle mapping (BUNDLE_CODE_MAP) on the suffix.
function stockPoolFor(catalog, sku) {
  let product = findProduct(catalog, sku);
  if (!product) {
    const mapped = skuSuffix(sku);
    product = mapped !== skuSuffixRaw(sku) ? (catalog.bySuffix.get(mapped) || [])[0] || null : null;
    if (!product) return null;
  }
  let current = product.sku;
  const seen = new Set();
  while (catalog.bySku.get(current) && catalog.bySku.get(current).sharesStockWith && !seen.has(current)) {
    seen.add(current);
    current = catalog.bySku.get(current).sharesStockWith;
  }
  return current;
}

/**
 * Stock for many SKUs in ONE database read (the dashboard's order grid used
 * to run one full-collection regex scan per item, every minute per tab).
 * Returns Map(sku -> stock | null | STOCK_UNAVAILABLE): null = not in
 * stock-manager at all, STOCK_UNAVAILABLE = stock-manager couldn't be read.
 * Read-only.
 */
async function lookupStockMany(skus) {
  const out = new Map();
  const wanted = [...new Set((skus || []).filter(Boolean))];
  if (!wanted.length) return out;
  try {
    const catalog = await loadCatalog();
    const sellable = await getSellableLocationCodes();
    const poolBySku = new Map(wanted.map((sku) => [sku, stockPoolFor(catalog, sku)]));
    const pools = [...new Set([...poolBySku.values()].filter(Boolean))];
    const rows = pools.length
      ? await withStockDb((db) =>
          db.collection('skustocks').find({ sku: { $in: pools } }, { projection: { sku: 1, onHand: 1, reserved: 1, locationCode: 1 } }).toArray(),
        )
      : [];
    const byPool = new Map();
    for (const r of rows) {
      if (!byPool.has(r.sku)) byPool.set(r.sku, []);
      byPool.get(r.sku).push(r);
    }
    for (const sku of wanted) {
      const pool = poolBySku.get(sku);
      const docs = pool ? byPool.get(pool) || [] : [];
      // Not in the catalog at all -> null ("not found"). In the catalog but
      // no stock row yet -> 0 (that's what stock-manager itself shows). Only
      // DAMAGED/QUARANTINE rows -> found, 0 sellable -> OUT OF STOCK.
      if (!pool) {
        out.set(sku, null);
        continue;
      }
      const sellableDocs = docs.filter((d) => sellable.has(d.locationCode));
      const onHand = sellableDocs.reduce((sum, d) => sum + (d.onHand || 0), 0);
      const reserved = sellableDocs.reduce((sum, d) => sum + (d.reserved || 0), 0);
      const available = onHand - reserved;
      out.set(sku, { onHand, reserved, available, ...classify(available) });
    }
  } catch (err) {
    console.error('Stock lookup failed:', err.message);
    for (const sku of wanted) out.set(sku, STOCK_UNAVAILABLE);
  }
  return out;
}

// Read-only lookup against stock-manager's live inventory — never writes.
// null = no match there; STOCK_UNAVAILABLE = couldn't read it (a stock hiccup
// never breaks the order alert — it just says it couldn't check).
async function lookupStock(sku) {
  if (!sku) return null;
  return (await lookupStockMany([sku])).get(sku) ?? null;
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
  if (stock.unavailable) return "Stock: ⚠️ couldn't check stock-manager right now\n";
  if (stock.level === 'out') {
    return stock.available === 0 ? `Stock: 🟡 Low (1 left)\n` : `Stock: 🔴 <b>OUT OF STOCK</b>\n`;
  }
  if (stock.level === 'low') return `Stock: 🟡 ${stock.label}\n`;
  return `Stock: ${stock.label}\n`;
}

// The product's category (e.g. "Co-ord Set") for an alert caption — its OWN
// product, not the shared stock pile. null when unknown or unreadable (never
// blocks the alert itself).
async function lookupCategory(sku) {
  if (!sku) return null;
  try {
    const product = findProduct(await loadCatalog(), sku);
    return (product && product.category) || null;
  } catch (err) {
    console.error('Category lookup failed:', err.message);
    return null;
  }
}

/**
 * The ACTIVE catalog product a resolved return SKU corresponds to (exact SKU,
 * else the same variant under another brand prefix) -> { sku, name }, or null
 * when the catalog genuinely has no such product. THROWS (err.stockUnavailable)
 * when stock-manager can't be read — callers must say "couldn't check", never
 * "isn't in the catalog" (that mix-up is what made a real product look
 * missing). A miss is re-checked against a fresh catalog read, so a product
 * added a moment ago is found straight away.
 */
async function lookupProductBySku(sku) {
  if (!sku) return null;
  try {
    let product = findProduct(await loadCatalog(), sku, { activeOnly: true });
    if (!product) product = findProduct(await loadCatalog({ fresh: true }), sku, { activeOnly: true });
    return product ? { sku: product.sku, name: product.name } : null;
  } catch (err) {
    console.error('Product lookup failed:', err.message);
    const e = new Error("Couldn't reach stock-manager to check the product — try again in a moment.");
    e.stockUnavailable = true;
    throw e;
  }
}

// Same normalisation stock-manager applies before saving a tracking id
// (its normalizeTracking/cleanTracking in src/lib/constants.ts) — so an id
// from Myntra compares equal to how stock-manager stored it.
function normalizeTracking(id) {
  if (id == null) return null;
  return String(id).trim().toUpperCase().replace(/[^A-Z0-9]/g, '') || null;
}

// Read-only: every RETURNED stock-log row whose trackingId is one of the
// given ids, grouped by (normalised) tracking id — what stock-manager graded
// each returned parcel as (GOOD / USED / FAKED / WRONG / DEFECTIVE). Older
// rows saved before conditions existed have `condition: null`; stock-manager
// itself treats those as GOOD (its editEntry() defaults them that way), so
// they're reported as GOOD here too. Unlike the other lookups in this file
// this one THROWS on failure — the caller (lib/spfPaid.js) needs to tell
// "stock-manager unreachable" apart from "nothing logged".
async function lookupReturnsByTracking(trackingIds) {
  const ids = [...new Set(trackingIds.map(normalizeTracking).filter(Boolean))];
  const byTracking = new Map();
  if (!ids.length) return byTracking;

  const rows = await withStockDb((db) =>
    db
      .collection('stockmovements')
      .find({ type: 'RETURNED', trackingId: { $in: ids } })
      .project({ sku: 1, qty: 1, condition: 1, trackingId: 1, createdAt: 1 })
      .sort({ createdAt: 1 })
      .toArray(),
  );

  for (const row of rows) {
    const key = normalizeTracking(row.trackingId);
    if (!byTracking.has(key)) byTracking.set(key, []);
    byTracking.get(key).push({
      id: String(row._id),
      sku: row.sku || null,
      qty: Math.max(1, Math.abs(Number(row.qty) || 1)),
      condition: row.condition || 'GOOD',
    });
  }
  return byTracking;
}

module.exports = {
  lookupStock,
  lookupStockMany,
  formatStockLine,
  lookupCategory,
  lookupProductBySku,
  lookupReturnsByTracking,
  normalizeTracking,
  skuSuffixRaw,
};
