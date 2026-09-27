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

module.exports = { skuSuffix };
