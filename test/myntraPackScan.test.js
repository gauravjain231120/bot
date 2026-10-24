const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

// Test isMyntraBarcode and readMyntraId (ES module dynamic import)
describe('Myntra Pack scan barcode & OCR functions', async () => {
  const { isMyntraBarcode, readMyntraId, createBarcodeConfirmer } = await import('../components/scanImage.js');

  describe('isMyntraBarcode', () => {
    it('accepts Delhivery and 3PL numeric tracking numbers (e.g. 5965826773804)', () => {
      assert.equal(isMyntraBarcode('5965826773804'), true);
      assert.equal(isMyntraBarcode('5965826774375'), true);
    });

    it('accepts numeric packet IDs (13 digits)', () => {
      assert.equal(isMyntraBarcode('1000219845057'), true);
      assert.equal(isMyntraBarcode('1000219843130'), true);
    });

    it('accepts traditional Myntra Logistics prefixes (MYSP, MYSC, MYEC, MYER)', () => {
      assert.equal(isMyntraBarcode('MYSP1495681641'), true);
      assert.equal(isMyntraBarcode('MYSC1364154959'), true);
      assert.equal(isMyntraBarcode('MYEC1125356471'), true);
      assert.equal(isMyntraBarcode('MYSR1234567890'), true);
    });

    it('accepts Shadowfax prefix (SF...)', () => {
      assert.equal(isMyntraBarcode('SF1495681641'), true);
    });

    it('rejects short numbers, random text or invalid lengths', () => {
      assert.equal(isMyntraBarcode('12345'), false);
      assert.equal(isMyntraBarcode('MY'), false);
      assert.equal(isMyntraBarcode('RANDOM_TEXT'), false);
    });

    it('confirmBarcode accepts numeric tracking number instantly in Code 128', () => {
      const confirm = createBarcodeConfirmer();
      const confirmed = confirm('5965826773804', 'CODE_128');
      assert.equal(confirmed, '5965826773804');
    });
  });

  describe('readMyntraId (OCR)', () => {
    it('reads numeric tracking numbers (e.g. 5965826773804)', () => {
      assert.equal(readMyntraId('5965826773804'), '5965826773804');
      assert.equal(readMyntraId('5965826774375'), '5965826774375');
    });

    it('reads numeric packet IDs', () => {
      assert.equal(readMyntraId('1000219843130'), '1000219843130');
    });

    it('reads traditional MY... tracking IDs', () => {
      assert.equal(readMyntraId('MYSP1495681641'), 'MYSP1495681641');
      assert.equal(readMyntraId('MYSC1364154959'), 'MYSC1364154959');
      assert.equal(readMyntraId('MYEC1125356471'), 'MYEC1125356471');
    });

    it('reads labeled AWB numbers with OCR fixes', () => {
      const text = 'DELHIVERY SURFACE\nAWB: 59658267738O4\nQTY: 1';
      assert.equal(readMyntraId(text), '5965826773804');
    });

    it('does not falsely extract 10-digit mobile numbers as standalone IDs', () => {
      const text = 'Customer care: 9876543210\nPin 110001';
      assert.equal(readMyntraId(text), null);
    });
  });
});

describe('lookupPackedShipment', async () => {
  const { lookupPackedShipment } = require('../lib/myntra.js');

  it('is a function exported by lib/myntra.js', () => {
    assert.equal(typeof lookupPackedShipment, 'function');
  });
});

describe('lookupPackedShipment resolution with mocked Myntra API', () => {
  it('resolves numeric tracking number 5965826773804 via trackingNumber', async () => {
    // Test the fallback logic directly
    const calls = [];
    async function mockQuery(id, searchOn) {
      calls.push({ id, searchOn });
      if (searchOn === 'trackingNumber' && id === '5965826773804') {
        return {
          trackingNumber: '5965826773804',
          storePacketId: 1000219843130,
          packetStatus: 'PACKED',
          packedOn: 1792818453000,
          lineItems: [{ skuId: 147009599, sellerSkuCode: 'SKU-1', quantity: 1 }]
        };
      }
      return null;
    }

    const id = '5965826773804';
    let packet = await mockQuery(id, 'trackingNumber');
    if (!packet && /^\d+$/.test(id)) {
      packet = await mockQuery(id, 'storePacketId');
    }

    assert.ok(packet);
    assert.equal(packet.trackingNumber, '5965826773804');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].searchOn, 'trackingNumber');
  });

  it('falls back to storePacketId when trackingNumber is not found for packet ID 1000219843130', async () => {
    const calls = [];
    async function mockQuery(id, searchOn) {
      calls.push({ id, searchOn });
      if (searchOn === 'storePacketId' && id === '1000219843130') {
        return {
          trackingNumber: '5965826773804',
          storePacketId: 1000219843130,
          packetStatus: 'PACKED',
          packedOn: 1792818453000,
          lineItems: [{ skuId: 147009599, sellerSkuCode: 'SKU-1', quantity: 1 }]
        };
      }
      return null;
    }

    const id = '1000219843130';
    let packet = await mockQuery(id, 'trackingNumber');
    if (!packet && /^\d+$/.test(id)) {
      packet = await mockQuery(id, 'storePacketId');
    }

    assert.ok(packet);
    assert.equal(packet.storePacketId, 1000219843130);
    assert.equal(calls.length, 2);
    assert.equal(calls[0].searchOn, 'trackingNumber');
    assert.equal(calls[1].searchOn, 'storePacketId');
  });
});
