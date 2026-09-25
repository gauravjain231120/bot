const assert = require('assert');

async function testGhostOrderFix() {
  // Mock DB and collections
  let alertsSent = 0;
  
  const db = {
    collection: (name) => {
      if (name === 'seenOrders') {
        return {
          find: (query) => {
            return {
              project: () => ({
                toArray: async () => {
                  // We'll say order 123 is in seenOrders (processed properly)
                  // and order 456 is NOT (ghost order)
                  const ids = query._id.$in;
                  return ids.filter(id => id === '123').map(id => ({ _id: id }));
                }
              })
            }
          }
        };
      }
    }
  };

  const sendOwnerAlert = async (msg) => {
    alertsSent++;
  };

  const escapeHtml = (s) => s;

  // Mock unresolved array (one processed order, one ghost order)
  const unresolved = [
    { orderId: '123', sku: 'SKU-1', qty: 1 },
    { orderId: '456', sku: 'SKU-2', qty: 2 } // This is the ghost order
  ];

  // ==========================================
  // The logic from lib/checkCancellations.js:
  // ==========================================
  
  const seenOrders = db.collection('seenOrders');
  const unresolvedOrderIds = [...new Set(unresolved.map((l) => String(l.orderId)))];
  const knownUnresolved = unresolvedOrderIds.length > 0
    ? await seenOrders.find({ _id: { $in: unresolvedOrderIds } }).project({ _id: 1 }).toArray()
    : [];
  const knownUnresolvedIds = new Set(knownUnresolved.map((d) => d._id));

  for (const line of unresolved) {
    if (!knownUnresolvedIds.has(String(line.orderId))) {
      console.log(`Silently ignoring unresolved cancellation for unseen ghost order ${line.orderId}`);
      continue;
    }

    await sendOwnerAlert(
      `⚠️ Cancelled line not fully found: ${line.orderId}`
    ).catch(() => {});
  }
  
  // ==========================================

  // Verify that only the alert for order '123' was sent, and '456' was ignored.
  assert.strictEqual(alertsSent, 1, 'Only 1 alert should have been sent (for order 123)');
  console.log('Test passed successfully!');
}

testGhostOrderFix().catch(console.error);
