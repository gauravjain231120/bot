const { getDb } = require('./db');
const { noteSessionFailure, sessionOkFields, sessionReplaced } = require('./sessionAlerts');
const { lookupStock, lookupCategory, formatStockLine } = require('./stock');
const { noteCheckFailure, checkOkFields } = require('./failureStreak');
const { fetchFlipkartOrders, formatFlipkartAlert, isFlipkartSessionExpired } = require('./flipkart');
const { sendOwnerAlert, sendOwnerPhoto } = require('./telegram');
const { escapeHtml } = require('./html');
const { logEngineEvent } = require('./engineLogger');
const { addToReadyToShip } = require('./readyToShip');
const { saveFlipkartOpenOrders } = require('./ordersSnapshot');

// Flipkart orders go ONLY to the owner for now.
async function alertNewFlipkartOrders(db, orders) {
  const col = db.collection('flipkart_seen_orders');
  let alerted = 0;

  for (const order of orders) {
    const id = order.orderId || order.groupId;
    if (!id) continue;

    const existing = await col.findOne({ _id: id });
    if (existing) continue;

    // Mark as seen immediately so we don't alert twice
    await col.updateOne(
      { _id: id },
      { $set: { firstSeen: new Date(), order } },
      { upsert: true }
    );

    const item = (order.items && order.items[0]) || {};
    const sku = item.sku;
    let stockLine = '';
    let category = '';
    if (sku) {
      try {
        const [stock, cat] = await Promise.all([lookupStock(sku), lookupCategory(sku)]);
        stockLine = formatStockLine(stock);
        category = cat;
      } catch (err) {
        console.error('Flipkart stock lookup failed:', err);
      }
    }
    const text = formatFlipkartAlert(order, orders.length, stockLine, category);

    try {
      if (item.image) {
        await sendOwnerPhoto(item.image, text);
      } else {
        await sendOwnerAlert(text);
      }
      
      // Add to Ready to Ship
      if (item.sku) {
        try {
          const placedAtMs = order.creationTime ? new Date(order.creationTime).getTime() : Date.now();
          const shipByMs = order.dispatchByDate ? new Date(order.dispatchByDate).getTime() : Date.now() + 86400000;
          
          const added = await addToReadyToShip({
            sku: item.sku,
            qty: item.quantity || 1,
            channel: 'FLIPKART',
            orderId: id,
            placedAtMs,
            shipByMs,
          });
          
          if (!added.ok) {
            await sendOwnerAlert(`⚠️ <b>Flipkart order not added to Ready to Ship</b>\nOrder ID: <code>${escapeHtml(id)}</code>\n${added.error}\nPlease add it manually.`);
          }
        } catch (err) {
          console.error('Failed to add Flipkart to RTS:', err);
        }
      }
      
      alerted++;
    } catch (err) {
      console.error('Flipkart alert failed for ' + id + ':', err.message);
    }
  }
  return alerted;
}

async function runCheckFlipkartOrders({ proxyData = null } = {}) {
  const db = await getDb();
  const settings = db.collection('settings');

  // Check if Flipkart is enabled
  const config = await settings.findOne({ _id: 'flipkart_config' });
  if (config && config.enabled === false) {
    return { skipped: true, reason: 'flipkart_disabled' };
  }

  const statusDoc = await settings.findOne({ _id: 'status' }) || {};

  if (!proxyData) {
    // Cloud mode: check if local extension is active
    if (statusDoc.flipkartLastProxyCheck) {
      const msSinceProxy = Date.now() - new Date(statusDoc.flipkartLastProxyCheck).getTime();
      const userIntervalMs = (statusDoc.flipkartProxyInterval || 5) * 60 * 1000;
      const fallbackMs = Math.max(5 * 60 * 1000, userIntervalMs + 90000);

      if (msSinceProxy < fallbackMs) {
        return { skipped: true, reason: 'local_mode_active' };
      }
    }

    // Switching to cloud
    if (statusDoc.flipkartScrapeMode === 'local') {
      await sendOwnerAlert('☁️ <b>Flipkart switched to Cloud Backup</b>\nThe laptop/browser went offline.', { silent: true }).catch(() => {});
      await logEngineEvent('flipkart', 'state_change', '☁️ Switched to Cloud (Local went offline)');
      await settings.updateOne({ _id: 'status' }, { $set: { flipkartScrapeMode: 'cloud' } });
    }

    // Jitter
    const jitterMs = Math.floor(Math.random() * 11000) + 1000;
    await new Promise(r => setTimeout(r, jitterMs));
  } else {
    // Local (extension) mode
    if (statusDoc.flipkartScrapeMode !== 'local') {
      await sendOwnerAlert('💻 <b>Flipkart switched to Local Browser</b>\nThe laptop/browser is online and checking orders.', { silent: true }).catch(() => {});
      await logEngineEvent('flipkart', 'state_change', '💻 Switched to Local Browser');
    }
    await settings.updateOne(
      { _id: 'status' },
      { $set: { flipkartLastProxyCheck: new Date().toISOString(), flipkartScrapeMode: 'local' } },
      { upsert: true }
    );
  }

  // Get session
  const sessionDoc = await settings.findOne({ _id: 'session_flipkart' });
  if (!proxyData && (!sessionDoc || !sessionDoc.headers)) {
    await settings.updateOne(
      { _id: 'status' },
      { $set: { flipkartLastError: new Date().toISOString() + ' No Flipkart session saved yet' } },
      { upsert: true }
    );
    await noteSessionFailure(
      settings,
      'flipkart',
      '⚠️ Flipkart session missing. Let the browser extension sync one.',
      { sessionDoc: null }
    );
    await logEngineEvent('flipkart', 'downtime', '🔴 Session missing or expired (No data fetched)');
    throw new Error('No Flipkart session saved yet.');
  }

  const headers = sessionDoc ? sessionDoc.headers : null;

  let orders;
  let total;
  try {
    if (proxyData) {
      orders = proxyData;
      total = proxyData.length;
    } else {
      const result = await fetchFlipkartOrders(headers);
      orders = result.orders;
      total = result.total;
    }
  } catch (err) {
    const status = err.response && err.response.status;
    if (await sessionReplaced(settings, 'session_flipkart', headers)) {
      throw new Error('Flipkart poll failed on a replaced session: ' + err.message);
    }
    const expired = isFlipkartSessionExpired(err);
    await settings.updateOne(
      { _id: 'status' },
      { $set: { flipkartLastError: new Date().toISOString() + ' ' + err.message } },
      { upsert: true }
    );
    if (expired) {
      await noteSessionFailure(settings, 'flipkart', '⚠️ Flipkart session expired. Log in to Flipkart Seller Hub in Chrome.', { sessionDoc });
      await logEngineEvent('flipkart', 'downtime', '🔴 Session expired (No data fetched)');
    } else {
      await noteCheckFailure(settings, 'flipkart', err.message);
      await logEngineEvent('flipkart', 'downtime', '🔴 Poll failed: ' + err.message);
    }
    throw err;
  }

  await settings.updateOne(
    { _id: 'status' },
    {
      $set: {
        ...sessionOkFields('flipkart'),
        ...checkOkFields('flipkart'),
        flipkartLastError: '',
        flipkartLastCheck: new Date().toISOString(),
        flipkartOpenCount: total,
      },
    },
    { upsert: true }
  );

  const newCount = await alertNewFlipkartOrders(db, orders);
  await saveFlipkartOpenOrders(orders);
  return { openCount: total, newCount };
}

module.exports = { runCheckFlipkartOrders };
