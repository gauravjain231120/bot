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

// Different marketplaces prefix the same underlying variant differently —
// RRC-010-CO-C-RED-M / RR-010-CO-C-RED-M / R-010-CO-C-RED-M are the same
// stock-manager variant. Compare only what's after the first "-".
function skuSuffix(sku) {
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
