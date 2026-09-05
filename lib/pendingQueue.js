const axios = require('axios');

const STOCK_MANAGER_URL = process.env.STOCK_MANAGER_URL || 'https://stock-manager-niko.vercel.app';

function authHeaders() {
  return { Cookie: `auth=${process.env.STOCK_MANAGER_AUTH_TOKEN}` };
}

// Called with every order just detected as cancelled — an order still sitting
// in stock-manager's Ready-to-Ship queue for one that's now cancelled would
// otherwise get packed and shipped for nothing. Removes every queue row for
// that order (a multi-item order has one row per SKU) through stock-manager's
// own API, which releases the reserved stock exactly like cancelling it by
// hand would — never a raw database write from this app.
//
// Best-effort: a failure here (stock-manager down, network hiccup) is logged
// and swallowed rather than thrown, so it never breaks the cancellation alert
// itself — the item just stays in the queue until the next successful pass.
async function removeCancelledOrdersFromQueue(orderIds) {
  const ids = [...new Set((orderIds || []).map(String).filter(Boolean))];
  if (ids.length === 0) return 0;

  let rows;
  try {
    const res = await axios.get(`${STOCK_MANAGER_URL}/api/pending/summary`, { headers: authHeaders() });
    rows = res.data && res.data.rows;
  } catch (err) {
    console.error('Could not reach Ready-to-Ship queue to remove cancelled orders:', err.message);
    return 0;
  }
  if (!Array.isArray(rows)) return 0;

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

module.exports = { removeCancelledOrdersFromQueue };
