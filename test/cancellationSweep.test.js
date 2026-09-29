// Unit tests for lib/cancellationSweep.js
//
// Validates the state-machine logic that handles partial cancellations,
// duplicate processing prevention, retries, and owner alerts.
//
// Run:  node --test test/cancellationSweep.test.js

const assert = require('node:assert/strict');
const { describe, it, beforeEach } = require('node:test');

// --- Stubs -------------------------------------------------------------------
// cancellationSweep destructures at require time, so the stub exports must be
// wrapper functions that delegate to a mutable `.impl` — reassigning
// `stub.queueRowsForOrder = ...` after require would not affect the already-
// captured reference.

const pendingImpl = {
  queueRowsForOrder: async () => [],
  removeUnits: async () => 0,
  cancelQueueRow: async () => 0,
  unshipLine: async () => ({ reversed: 0, remaining: 0 }),
};
require.cache[require.resolve('../lib/pendingQueue')] = {
  id: require.resolve('../lib/pendingQueue'),
  filename: require.resolve('../lib/pendingQueue'),
  loaded: true,
  exports: {
    queueRowsForOrder: (...a) => pendingImpl.queueRowsForOrder(...a),
    removeUnits: (...a) => pendingImpl.removeUnits(...a),
    cancelQueueRow: (...a) => pendingImpl.cancelQueueRow(...a),
    unshipLine: (...a) => pendingImpl.unshipLine(...a),
  },
};

const telegramImpl = { sendOwnerAlert: async () => ({ sent: 1 }) };
require.cache[require.resolve('../lib/telegram')] = {
  id: require.resolve('../lib/telegram'),
  filename: require.resolve('../lib/telegram'),
  loaded: true,
  exports: {
    sendOwnerAlert: (...a) => telegramImpl.sendOwnerAlert(...a),
  },
};

require.cache[require.resolve('../lib/html')] = {
  id: require.resolve('../lib/html'),
  filename: require.resolve('../lib/html'),
  loaded: true,
  exports: { escapeHtml: (s) => String(s) },
};

require.cache[require.resolve('../lib/skuSuffix')] = {
  id: require.resolve('../lib/skuSuffix'),
  filename: require.resolve('../lib/skuSuffix'),
  loaded: true,
  exports: {
    skuSuffix(sku) {
      if (!sku) return '';
      const idx = sku.indexOf('-');
      return (idx === -1 ? sku : sku.slice(idx + 1)).trim().toUpperCase();
    },
  },
};

// NOW require the module under test
const {
  claimCancellation,
  processCancellation,
  noteCancellationFailure,
  OWNER_ALERT_AFTER_MS,
  INCOMPLETE_WAIT_MS,
} = require('../lib/cancellationSweep');

// --- Helpers -----------------------------------------------------------------

/** Fake MongoDB collection backed by a plain Map. */
function fakeCollection(initialDocs = []) {
  const docs = new Map();
  for (const d of initialDocs) docs.set(d._id, structuredClone(d));

  return {
    _docs: docs,
    get(id) { return structuredClone(docs.get(id)) || null; },

    async findOneAndUpdate(filter, update) {
      const id = filter._id;
      const doc = docs.get(id);
      if (!doc) return null;
      if (filter.$or) {
        const claimed = doc.claimedAt;
        const expired = filter.$or[1]?.claimedAt?.$lt;
        if (claimed != null && (!expired || claimed >= expired)) return null;
      }
      if (update.$set) Object.assign(doc, update.$set);
      return structuredClone(doc);
    },

    async updateOne(filter, update) {
      const id = filter._id;
      const doc = docs.get(id);
      if (!doc) return { modifiedCount: 0 };
      if (update.$set) {
        for (const [key, val] of Object.entries(update.$set)) {
          const parts = key.split('.');
          let target = doc;
          for (let i = 0; i < parts.length - 1; i++) {
            if (!target[parts[i]]) target[parts[i]] = {};
            target = target[parts[i]];
          }
          target[parts[parts.length - 1]] = val;
        }
      }
      return { modifiedCount: 1 };
    },
  };
}

function makeDoc(id, overrides = {}) {
  return {
    _id: id,
    claimedAt: null,
    signature: null,
    processed: {},
    work: null,
    failingSince: null,
    failingSig: null,
    ownerAlerted: false,
    lastError: null,
    plainAlertedSig: null,
    ...overrides,
  };
}

// --- Tests -------------------------------------------------------------------

describe('claimCancellation', () => {
  it('claims an unclaimed document', async () => {
    const col = fakeCollection([makeDoc('order-1')]);
    const result = await claimCancellation(col, 'order-1');
    assert.ok(result, 'should return the claimed document');
    assert.ok(result.claimedAt instanceof Date);
  });

  it('returns null if already claimed (not expired)', async () => {
    const col = fakeCollection([makeDoc('order-1', { claimedAt: new Date() })]);
    const result = await claimCancellation(col, 'order-1');
    assert.equal(result, null, 'should not claim an active lease');
  });

  it('reclaims an expired lease', async () => {
    const old = new Date(Date.now() - 5 * 60 * 1000);
    const col = fakeCollection([makeDoc('order-1', { claimedAt: old })]);
    const result = await claimCancellation(col, 'order-1');
    assert.ok(result, 'should reclaim an expired lease');
  });
});

describe('processCancellation', () => {
  let alertsSent;
  let sendAlert;

  beforeEach(() => {
    alertsSent = [];
    sendAlert = async (units) => {
      alertsSent.push(units);
      return { sent: 1 };
    };
    // Reset stubs
    pendingImpl.queueRowsForOrder = async () => [];
    pendingImpl.removeUnits = async () => 0;
    pendingImpl.unshipLine = async () => ({ reversed: 0, remaining: 0 });
    telegramImpl.sendOwnerAlert = async () => ({ sent: 1 });
  });

  it('processes a simple single-unit cancellation', async () => {
    const doc = makeDoc('order-1');
    const col = fakeCollection([doc]);

    const result = await processCancellation({
      col, doc, orderId: 'order-1', sig: 'sig-v1',
      cancelledNow: { 'CO-CI-RED-M': { qty: 1, sku: 'RRC-001-CO-CI-RED-M' } },
      baseline: {}, queuedByUs: false, sendAlert, label: 'Myntra',
    });

    assert.equal(result.done, true);
    assert.equal(result.newlyUnits, 1);
    assert.equal(alertsSent.length, 1);
    assert.equal(alertsSent[0][0].qty, 1);
    assert.equal(alertsSent[0][0].suffix, 'CO-CI-RED-M');
  });

  it('does not re-announce already announced units', async () => {
    const doc = makeDoc('order-1', {
      work: {
        sig: 'sig-v1', newly: { 'CO-CI-RED-M': 1 },
        announced: { 'CO-CI-RED-M': 1 },
        removed: {}, unshipped: {}, unresolved: {}, skipped: {}, deleting: null,
      },
    });
    const col = fakeCollection([doc]);

    const result = await processCancellation({
      col, doc, orderId: 'order-1', sig: 'sig-v1',
      cancelledNow: { 'CO-CI-RED-M': { qty: 1, sku: 'RRC-001-CO-CI-RED-M' } },
      baseline: {}, queuedByUs: false, sendAlert, label: 'Myntra',
    });

    assert.equal(result.done, true);
    assert.equal(alertsSent.length, 0, 'should NOT re-announce');
  });

  it('handles partial cancellation (2 of 3 units)', async () => {
    const doc = makeDoc('order-1');
    const col = fakeCollection([doc]);

    const result = await processCancellation({
      col, doc, orderId: 'order-1', sig: 'sig-v1',
      cancelledNow: { 'CO-CI-RED-M': { qty: 2, sku: 'RRC-001-CO-CI-RED-M' } },
      liveNow: { 'CO-CI-RED-M': 1 },
      baseline: {}, queuedByUs: false, sendAlert, label: 'Myntra',
    });

    assert.equal(result.done, true);
    assert.equal(result.newlyUnits, 2);
  });

  it('skips units already in baseline', async () => {
    const doc = makeDoc('order-1');
    const col = fakeCollection([doc]);

    const result = await processCancellation({
      col, doc, orderId: 'order-1', sig: 'sig-v2',
      cancelledNow: { 'CO-CI-RED-M': { qty: 3, sku: 'RRC-001-CO-CI-RED-M' } },
      baseline: { 'CO-CI-RED-M': 2 },
      queuedByUs: false, sendAlert, label: 'Myntra',
    });

    assert.equal(result.done, true);
    assert.equal(result.newlyUnits, 1, 'only 1 new unit (3 total - 2 baseline)');
  });

  it('removes queued units for orders we queued', async () => {
    const doc = makeDoc('order-1');
    const col = fakeCollection([doc]);

    pendingImpl.queueRowsForOrder = async () => [
      { id: 'row-1', sku: 'RRC-001-CO-CI-RED-M', qty: 2 },
    ];
    const removedCalls = [];
    pendingImpl.removeUnits = async (rows, suffix, qty, hooks) => {
      removedCalls.push({ suffix, qty });
      // Simulate the before/after hooks like the real removeUnits does
      if (hooks && hooks.before) await hooks.before(rows[0], qty);
      if (hooks && hooks.after) await hooks.after(qty);
      return qty;
    };

    const result = await processCancellation({
      col, doc, orderId: 'order-1', sig: 'sig-v1',
      cancelledNow: { 'CO-CI-RED-M': { qty: 1, sku: 'RRC-001-CO-CI-RED-M' } },
      baseline: {}, queuedByUs: true, sendAlert, label: 'Myntra',
    });

    assert.equal(result.done, true);
    assert.equal(result.removed, 1);
    assert.equal(removedCalls.length, 1);
    assert.equal(removedCalls[0].suffix, 'CO-CI-RED-M');
  });

  it('unships shortfall when queue has fewer than cancelled', async () => {
    const doc = makeDoc('order-1');
    const col = fakeCollection([doc]);

    pendingImpl.queueRowsForOrder = async () => [];
    pendingImpl.removeUnits = async () => 0;
    pendingImpl.unshipLine = async ({ qty }) => ({ reversed: qty, remaining: 0 });

    const result = await processCancellation({
      col, doc, orderId: 'order-1', sig: 'sig-v1',
      cancelledNow: { 'CO-CI-RED-M': { qty: 1, sku: 'RRC-001-CO-CI-RED-M' } },
      baseline: {}, queuedByUs: true, sendAlert, label: 'Myntra',
    });

    assert.equal(result.done, true);
    assert.equal(result.unshipped, 1);
  });

  it('alerts owner when unship has remaining', async () => {
    const doc = makeDoc('order-1');
    const col = fakeCollection([doc]);
    let ownerAlerted = false;

    pendingImpl.queueRowsForOrder = async () => [];
    pendingImpl.removeUnits = async () => 0;
    pendingImpl.unshipLine = async () => ({ reversed: 0, remaining: 1 });
    telegramImpl.sendOwnerAlert = async () => {
      ownerAlerted = true;
      return { sent: 1 };
    };

    const result = await processCancellation({
      col, doc, orderId: 'order-1', sig: 'sig-v1',
      cancelledNow: { 'CO-CI-RED-M': { qty: 1, sku: 'RRC-001-CO-CI-RED-M' } },
      baseline: {}, queuedByUs: true, sendAlert, label: 'Myntra',
    });

    assert.equal(result.done, true);
    assert.equal(result.unresolved, 1);
    assert.ok(ownerAlerted, 'should alert owner about unresolved units');
  });

  it('skips non-queued-by-us units not in the queue', async () => {
    const doc = makeDoc('order-1');
    const col = fakeCollection([doc]);

    pendingImpl.queueRowsForOrder = async () => [];
    pendingImpl.removeUnits = async () => 0;

    const result = await processCancellation({
      col, doc, orderId: 'order-1', sig: 'sig-v1',
      cancelledNow: { 'CO-CI-RED-M': { qty: 1, sku: 'RRC-001-CO-CI-RED-M' } },
      baseline: {}, queuedByUs: false, sendAlert, label: 'Amazon',
    });

    assert.equal(result.done, true);
    assert.equal(result.unshipped, 0);
  });

  it('handles incomplete cancellation (waits for detail)', async () => {
    const doc = makeDoc('order-1');
    const col = fakeCollection([doc]);
    const now = Date.now();

    const result = await processCancellation({
      col, doc, orderId: 'order-1', sig: 'sig-v1',
      cancelledNow: { 'CO-CI-RED-M': { qty: 1, sku: 'RRC-001-CO-CI-RED-M' } },
      baseline: {}, queuedByUs: false,
      complete: false, expected: 2,
      sendAlert, label: 'Myntra', now,
    });

    assert.equal(result.done, false);
    assert.equal(result.waiting, true);
  });

  it('accepts incomplete after INCOMPLETE_WAIT_MS', async () => {
    const waitStart = Date.now() - INCOMPLETE_WAIT_MS - 1000;
    const doc = makeDoc('order-1', {
      work: {
        sig: 'sig-v1', newly: { 'CO-CI-RED-M': 1 },
        announced: { 'CO-CI-RED-M': 1 },
        removed: {}, unshipped: {}, unresolved: {}, skipped: {}, deleting: null,
        incompleteSince: new Date(waitStart),
      },
    });
    const col = fakeCollection([doc]);
    let ownerNotified = false;
    telegramImpl.sendOwnerAlert = async () => {
      ownerNotified = true;
      return { sent: 1 };
    };

    const result = await processCancellation({
      col, doc, orderId: 'order-1', sig: 'sig-v1',
      cancelledNow: { 'CO-CI-RED-M': { qty: 1, sku: 'RRC-001-CO-CI-RED-M' } },
      baseline: {}, queuedByUs: false,
      complete: false, expected: 2,
      sendAlert, label: 'Myntra',
    });

    assert.equal(result.done, true, 'should accept after wait period');
    assert.ok(ownerNotified, 'owner should be told about the gap');
  });

  it('handles multi-variant cancellation', async () => {
    const doc = makeDoc('order-1');
    const col = fakeCollection([doc]);

    const result = await processCancellation({
      col, doc, orderId: 'order-1', sig: 'sig-v1',
      cancelledNow: {
        'CO-CI-RED-M': { qty: 1, sku: 'RRC-001-CO-CI-RED-M' },
        'CO-CI-BLU-L': { qty: 2, sku: 'RRC-001-CO-CI-BLU-L' },
      },
      baseline: {}, queuedByUs: false, sendAlert, label: 'Myntra',
    });

    assert.equal(result.done, true);
    assert.equal(result.newlyUnits, 3, '1 red + 2 blue');
  });

  it('seeds announced from leftOut (async function)', async () => {
    const doc = makeDoc('order-1');
    const col = fakeCollection([doc]);

    const result = await processCancellation({
      col, doc, orderId: 'order-1', sig: 'sig-v1',
      cancelledNow: { 'CO-CI-RED-M': { qty: 1, sku: 'RRC-001-CO-CI-RED-M' } },
      baseline: {},
      leftOut: async () => ({ 'CO-CI-RED-M': 1 }),
      queuedByUs: false, sendAlert, label: 'Myntra',
    });

    assert.equal(result.done, true);
    assert.equal(alertsSent.length, 0, 'already left out → no cancel alert');
  });

  it('returns error on queue failure without crashing', async () => {
    const doc = makeDoc('order-1');
    const col = fakeCollection([doc]);

    pendingImpl.queueRowsForOrder = async () => { throw new Error('stock-manager down'); };

    const result = await processCancellation({
      col, doc, orderId: 'order-1', sig: 'sig-v1',
      cancelledNow: { 'CO-CI-RED-M': { qty: 1, sku: 'RRC-001-CO-CI-RED-M' } },
      baseline: {}, queuedByUs: true, sendAlert, label: 'Myntra',
    });

    assert.equal(result.done, false);
    assert.ok(result.error.includes('Ready to Ship'));
  });

  it('second cancellation on same order processes only new units', async () => {
    // First cancellation handled: 1 unit of RED-M
    const doc = makeDoc('order-1', {
      signature: 'sig-v1',
      processed: { 'CO-CI-RED-M': 1 },
    });
    const col = fakeCollection([doc]);

    // Second cancellation: now 1 RED-M + 1 BLU-L
    const result = await processCancellation({
      col, doc, orderId: 'order-1', sig: 'sig-v2',
      cancelledNow: {
        'CO-CI-RED-M': { qty: 1, sku: 'RRC-001-CO-CI-RED-M' },
        'CO-CI-BLU-L': { qty: 1, sku: 'RRC-001-CO-CI-BLU-L' },
      },
      baseline: { 'CO-CI-RED-M': 1 }, // RED-M already processed
      queuedByUs: false, sendAlert, label: 'Myntra',
    });

    assert.equal(result.done, true);
    assert.equal(result.newlyUnits, 1, 'only BLU-L is new');
    assert.equal(alertsSent.length, 1);
    assert.equal(alertsSent[0][0].suffix, 'CO-CI-BLU-L');
  });
});

describe('noteCancellationFailure', () => {
  beforeEach(() => {
    telegramImpl.sendOwnerAlert = async () => ({ sent: 1 });
  });

  it('saves the error and releases the lease', async () => {
    const doc = makeDoc('order-1', { claimedAt: new Date() });
    const col = fakeCollection([doc]);

    await noteCancellationFailure(col, doc, 'order-1', 'something broke', 'Myntra', 'sig-v1');

    const updated = col.get('order-1');
    assert.equal(updated.lastError, 'something broke');
    assert.equal(updated.claimedAt, null);
    assert.ok(updated.failingSince instanceof Date);
  });

  it('alerts owner after OWNER_ALERT_AFTER_MS', async () => {
    const longAgo = Date.now() - OWNER_ALERT_AFTER_MS - 1000;
    const doc = makeDoc('order-1', {
      failingSince: new Date(longAgo),
      failingSig: 'sig-v1',
      ownerAlerted: false,
    });
    const col = fakeCollection([doc]);
    let alerted = false;
    telegramImpl.sendOwnerAlert = async () => { alerted = true; return { sent: 1 }; };

    await noteCancellationFailure(col, doc, 'order-1', 'still broken', 'Myntra', 'sig-v1');

    assert.ok(alerted, 'owner should be alerted after threshold');
    const updated = col.get('order-1');
    assert.equal(updated.ownerAlerted, true);
  });

  it('does not re-alert owner', async () => {
    const longAgo = Date.now() - OWNER_ALERT_AFTER_MS - 1000;
    const doc = makeDoc('order-1', {
      failingSince: new Date(longAgo),
      failingSig: 'sig-v1',
      ownerAlerted: true,
    });
    const col = fakeCollection([doc]);
    let alertCount = 0;
    telegramImpl.sendOwnerAlert = async () => { alertCount++; return { sent: 1 }; };

    await noteCancellationFailure(col, doc, 'order-1', 'still broken', 'Myntra', 'sig-v1');

    assert.equal(alertCount, 0, 'should not re-alert');
  });

  it('resets ownerAlerted on new signature', async () => {
    const doc = makeDoc('order-1', {
      failingSince: new Date(),
      failingSig: 'sig-v1',
      ownerAlerted: true,
    });
    const col = fakeCollection([doc]);

    await noteCancellationFailure(col, doc, 'order-1', 'new error', 'Myntra', 'sig-v2');

    const updated = col.get('order-1');
    assert.equal(updated.ownerAlerted, false);
    assert.equal(updated.failingSig, 'sig-v2');
  });
});
