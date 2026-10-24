const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const { alignSkuWithSize, normalizeApparelSize, APPAREL_SIZES } = require('../lib/skuSuffix');
const { groupOrderRows } = require('../lib/myntra');

describe('alignSkuWithSize', () => {
  it('corrects SKU size suffix when it mismatches the ordered size (the reported issue)', () => {
    // E.g. SKU R-002-CO-L-PNK-L ordered in Size S
    assert.equal(alignSkuWithSize('R-002-CO-L-PNK-L', 'S'), 'R-002-CO-L-PNK-S');
    assert.equal(alignSkuWithSize('RRC-002-CO-L-PNK-L', 'S'), 'RRC-002-CO-L-PNK-S');
  });

  it('preserves correct SKU when size already matches', () => {
    assert.equal(alignSkuWithSize('RR-002-CO-H-GRN-S', 'S'), 'RR-002-CO-H-GRN-S');
    assert.equal(alignSkuWithSize('R-007-CO-C-RED-M', 'M'), 'R-007-CO-C-RED-M');
    assert.equal(alignSkuWithSize('RRC-002-CO-F-BLU-XL', 'XL'), 'RRC-002-CO-F-BLU-XL');
  });

  it('normalizes 2XL / XXL mappings correctly', () => {
    // Myntra sends '2XL', Stock Manager uses 'XXL'
    assert.equal(alignSkuWithSize('R-007-CO-K-YL-M', '2XL'), 'R-007-CO-K-YL-XXL');
    assert.equal(alignSkuWithSize('R-007-CO-K-YL-XXL', '2XL'), 'R-007-CO-K-YL-XXL');
  });

  it('normalizes 3XL / XXXL mappings correctly', () => {
    assert.equal(alignSkuWithSize('R-007-CO-K-YL-M', '3XL'), 'R-007-CO-K-YL-3XL');
    assert.equal(alignSkuWithSize('R-007-CO-K-YL-M', 'XXXL'), 'R-007-CO-K-YL-3XL');
  });

  it('leaves Free Size / Onesize SKUs untouched', () => {
    assert.equal(alignSkuWithSize('RRC-006-CO-A-BLU', 'Free Size'), 'RRC-006-CO-A-BLU');
    assert.equal(alignSkuWithSize('RRC-006-CO-A-BLU', 'FS'), 'RRC-006-CO-A-BLU');
    assert.equal(alignSkuWithSize('RRC-006-CO-A-BLU', 'Onesize'), 'RRC-006-CO-A-BLU');
  });

  it('does not replace non-size SKU endings even if size is standard', () => {
    // E.g. RRC-006-CO-A-BLU has no size suffix (BLU is color)
    assert.equal(alignSkuWithSize('RRC-006-CO-A-BLU', 'S'), 'RRC-006-CO-A-BLU');
    assert.equal(alignSkuWithSize('RRC-006-CO-C-RED', 'M'), 'RRC-006-CO-C-RED');
  });

  it('handles empty, null, or undefined inputs gracefully', () => {
    assert.equal(alignSkuWithSize(null, 'S'), null);
    assert.equal(alignSkuWithSize('R-002-CO-L-PNK-L', null), 'R-002-CO-L-PNK-L');
    assert.equal(alignSkuWithSize('', 'S'), '');
    assert.equal(alignSkuWithSize('R-002', 'S'), 'R-002');
  });
});

describe('groupOrderRows with aligned SKUs', () => {
  it('groups items under the corrected SKU when size mismatches', () => {
    const rawRows = [
      { sellerSkuCode: 'RR-002-CO-H-GRN-S', size: 'S', status: 'CREATED' },
      { sellerSkuCode: 'RR-002-CO-C-RED-S', size: 'S', status: 'CREATED' },
      { sellerSkuCode: 'R-002-CO-L-PNK-L', size: 'S', status: 'CREATED' },
    ];

    const grouped = groupOrderRows(rawRows, ['CREATED']);
    assert.equal(grouped.length, 3);
    assert.equal(grouped[0].sku, 'RR-002-CO-H-GRN-S');
    assert.equal(grouped[1].sku, 'RR-002-CO-C-RED-S');
    assert.equal(grouped[2].sku, 'R-002-CO-L-PNK-S');
    assert.equal(grouped[2].sellerSkuCode, 'R-002-CO-L-PNK-S');
  });

  it('aggregates quantities of same corrected SKU', () => {
    const rawRows = [
      { sellerSkuCode: 'R-002-CO-L-PNK-L', size: 'S', status: 'CREATED' },
      { sellerSkuCode: 'R-002-CO-L-PNK-S', size: 'S', status: 'CREATED' },
    ];

    const grouped = groupOrderRows(rawRows, ['CREATED']);
    assert.equal(grouped.length, 1);
    assert.equal(grouped[0].sku, 'R-002-CO-L-PNK-S');
    assert.equal(grouped[0].qty, 2);
  });
});
