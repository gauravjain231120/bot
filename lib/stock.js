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
    const escaped = suffix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const docs = await db
      .collection('skustocks')
      .find({ sku: { $regex: `-${escaped}$`, $options: 'i' } })
      .project({ onHand: 1, reserved: 1 })
      .toArray();

    if (docs.length === 0) return null;

    const onHand = docs.reduce((sum, d) => sum + (d.onHand || 0), 0);
    const reserved = docs.reduce((sum, d) => sum + (d.reserved || 0), 0);
    const available = onHand - reserved;

    return { onHand, reserved, available, ...classify(available) };
  } catch (err) {
    console.error('Stock lookup failed:', err.message);
    return null;
  }
}

// Telegram's HTML parse mode has no color support — bold + a colored circle
// emoji is the closest equivalent to "red bold out of stock" it can render.
function formatStockLine(stock) {
  if (!stock) return '';
  if (stock.level === 'out') return `Stock: 🔴 <b>OUT OF STOCK</b>\n`;
  if (stock.level === 'low') return `Stock: 🟡 ${stock.label}\n`;
  return `Stock: ${stock.label}\n`;
}

module.exports = { lookupStock, formatStockLine };
