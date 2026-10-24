// Marketplaces prefix the same variant differently (RRC-002-.../RR-002-.../
// R-002-...) — everything after the first "-", uppercased, is the variant.
// Same convention as lib/stock.js and stock-manager's own resolution.
// Also used as a key in stored progress documents, so the two characters
// MongoDB field names can't hold ('.' and '$') become '_' (real SKUs have none).
function skuSuffix(sku) {
  if (!sku) return '';
  const s = String(sku);
  const idx = s.indexOf('-');
  return (idx === -1 ? s : s.slice(idx + 1)).trim().toUpperCase().replace(/[.$]/g, '_');
}

/**
 * Standard apparel sizes used in the catalog (stock-manager STANDARD_SIZES).
 * In Myntra seller SKUs, the size is the trailing segment after the last hyphen
 * (e.g., R-002-CO-L-PNK-L -> size 'L').
 * If a listing mistake on Myntra maps an SKU with a size suffix that differs from
 * the actual ordered size (e.g., SKU R-002-CO-L-PNK-L for ordered size 'S'),
 * this aligns the SKU to match the true ordered size (R-002-CO-L-PNK-S).
 */
const APPAREL_SIZES = new Set(['XS', 'S', 'M', 'L', 'XL', 'XXL', '3XL', '4XL', '5XL']);

function normalizeApparelSize(raw) {
  const s = String(raw || '').trim().toUpperCase();
  if (s === '2XL') return 'XXL';
  if (s === '3XL' || s === 'XXXL') return '3XL';
  return s;
}

function alignSkuWithSize(rawSku, rawSize) {
  if (!rawSku) return rawSku;
  const sku = String(rawSku).trim();
  if (!rawSize) return sku;

  const targetSize = normalizeApparelSize(rawSize);
  if (!APPAREL_SIZES.has(targetSize)) {
    // Non-standard or Free Size (e.g. 'Free Size', 'FS', 'Onesize') — don't alter
    return sku;
  }

  const parts = sku.split('-');
  if (parts.length < 2) return sku;

  const lastPart = parts[parts.length - 1].trim().toUpperCase();
  const lastSize = normalizeApparelSize(lastPart);

  // Only replace if the SKU already ends with a recognized apparel size
  // (prevents accidentally altering non-size suffixes like 'RRC-006-CO-A-BLU')
  if (!APPAREL_SIZES.has(lastSize)) {
    return sku;
  }

  if (lastSize === targetSize) {
    return sku;
  }

  // Mismatch: replace the size suffix with the actual ordered size
  parts[parts.length - 1] = targetSize;
  return parts.join('-');
}

module.exports = { skuSuffix, alignSkuWithSize, normalizeApparelSize, APPAREL_SIZES };
