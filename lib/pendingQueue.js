const axios = require('axios');

const STOCK_MANAGER_URL = process.env.STOCK_MANAGER_URL || 'https://stock-manager-niko.vercel.app';

function authHeaders() {
  return { Cookie: `auth=${process.env.STOCK_MANAGER_AUTH_TOKEN}` };
}

async function fetchQueueRows() {
  const res = await axios.get(`${STOCK_MANAGER_URL}/api/pending/summary`, { headers: authHeaders() });
  return Array.isArray(res.data && res.data.rows) ? res.data.rows : [];
}

// Different marketplaces prefix the same underlying variant differently
// (RRC-002-.../RR-002-.../R-002-...) — compare only what's after the first
// "-", same convention as lib/stock.js's skuSuffix. Needed because a queue
// row's own `sku` is stock-manager's actual catalog SKU (whichever prefix
// that specific product happens to use there), not necessarily the literal
// marketplace SKU string from the cancellation payload.
function skuSuffix(sku) {
  if (!sku) return '';
  const idx = sku.indexOf('-');
  return (idx === -1 ? sku : sku.slice(idx + 1)).trim().toUpperCase();
}

// WHOLE-ORDER removal — kept only as a fallback for when a specific order's
// item detail couldn't be fetched (see removeCancelledLinesFromQueue for the
// normal, precise path used whenever that fetch succeeds). Removes every
// queue row for that order, so this has no way to spare a still-live line on
// an order that was only partially cancelled — use it only when there's
// truly no better information available.
//
// Best-effort: a failure here (stock-manager down, network hiccup) is logged
// and swallowed rather than thrown, so it never breaks the cancellation alert
// itself — the item just stays in the queue until the next successful pass.
async function removeCancelledOrdersFromQueue(orderIds) {
  const ids = [...new Set((orderIds || []).map(String).filter(Boolean))];
  if (ids.length === 0) return 0;

  let rows;
  try {
    rows = await fetchQueueRows();
  } catch (err) {
    console.error('Could not reach Ready-to-Ship queue to remove cancelled orders:', err.message);
    return 0;
  }

  const idSet = new Set(ids);
  const matches = rows.filter((r) => idSet.has(String(r.orderId)));

  let removed = 0;
  for (const row of matches) {
    try {
      await axios.delete(`${STOCK_MANAGER_URL}/api/pending/${row.id}`, { headers: authHeaders() });
      removed++;
    } catch (err) {
      console.error(`Failed to remove cancelled order ${row.orderId} (${row.id}) from queue:`, err.message);
    }
  }
  return removed;
}

// Precise removal: takes exactly the {orderId, sku, qty} lines Myntra
// actually marked CANCELLED (see fetchOrderItems's `statuses` filter in
// lib/myntra.js) and removes only that many queue rows per order+SKU —
// never the whole order. Myntra's cancellations feed only ever reports at
// the order level, but a multi-item order can be only partially cancelled;
// removing every row for the order on any cancellation used to wipe out
// still-live lines too (real incident: order 6026100011, 2026-09-20, where a
// 1-unit cancellation deleted the entire order's queue entry, including an
// untouched second SKU — see PROJECT.md). Rows for the same order+SKU are
// interchangeable physical units, so which specific row instance gets
// removed doesn't matter — only how many.
async function removeCancelledLinesFromQueue(lines) {
  const wanted = (lines || []).filter((l) => l && l.orderId && l.sku && l.qty > 0);
  if (wanted.length === 0) return 0;

  let rows;
  try {
    rows = await fetchQueueRows();
  } catch (err) {
    console.error('Could not reach Ready-to-Ship queue to remove cancelled lines:', err.message);
    return 0;
  }

  let removed = 0;
  for (const { orderId, sku, qty } of wanted) {
    const suffix = skuSuffix(sku);
    const matches = rows.filter((r) => String(r.orderId) === String(orderId) && skuSuffix(r.sku) === suffix);
    for (const row of matches.slice(0, qty)) {
      try {
        await axios.delete(`${STOCK_MANAGER_URL}/api/pending/${row.id}`, { headers: authHeaders() });
        rows = rows.filter((r) => r.id !== row.id); // don't let another line re-match this row
        removed++;
      } catch (err) {
        console.error(`Failed to remove cancelled line ${orderId}/${sku} (${row.id}) from queue:`, err.message);
      }
    }
  }
  return removed;
}

module.exports = { removeCancelledOrdersFromQueue, removeCancelledLinesFromQueue };
