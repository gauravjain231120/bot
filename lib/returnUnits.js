// One scanned return parcel can hold 2+ items: different products, or 2+
// units of ONE product. The return pages show and log it ONE PHYSICAL UNIT at
// a time — each unit gets its own condition (one came back fine, the other
// damaged) and its own "Add" (qty 1). Shared by the Myntra and Amazon Return
// pages; pure functions (no React), so they're tested directly.
//
// Every unit carries:
//   key         "<product>#<n>" (Amazon: "<return>:<product>#<n>") — stable
//               across rescans even if the marketplace lists items in a
//               different order, so "✓ Added" lands on the right unit
//   n           which unit of that product this is (1-based)
//   unitsOfSku  how many units of that product the parcel holds — sent to
//               stock-manager as `expectedUnits`, so a genuine 2nd unit logs
//               normally and only an extra one (a rescan / double tap) is
//               stopped as a duplicate

/** Brand prefix dropped — RRC- / RR- / R- are the same product. */
export function skuSuffix(sku) {
  const s = String(sku || '').trim().toUpperCase();
  const i = s.indexOf('-');
  return i === -1 ? s : s.slice(i + 1);
}

/**
 * Myntra: the resolver returns one candidate per SPF claim, and Myntra raises
 * one claim per order LINE = one physical unit (verified live: a claim is tied
 * to an `orderLineId`, `pickedCount: 1`). So candidates already are units —
 * this only numbers them per product.
 */
export function myntraUnits(candidates) {
  const totals = new Map();
  for (const c of candidates) {
    const k = skuSuffix(c.matchedSku ?? c.resolvedSku);
    totals.set(k, (totals.get(k) || 0) + 1);
  }
  const seen = new Map();
  return candidates.map((c) => {
    const k = skuSuffix(c.matchedSku ?? c.resolvedSku);
    const n = (seen.get(k) || 0) + 1;
    seen.set(k, n);
    return { ...c, unitKey: `${k}#${n}`, unitN: n, unitsOfSku: totals.get(k) };
  });
}

/**
 * Amazon: a return request lists items with a quantity (a customer can send
 * back 2 of one product) — expanded into one unit per piece.
 */
export function amazonUnits(rr) {
  const qtyOf = (it) => Math.max(1, Math.floor(Number(it.quantity)) || 1);
  const totals = new Map();
  for (const it of rr.items || []) {
    const k = skuSuffix(it.sku || it.asin);
    totals.set(k, (totals.get(k) || 0) + qtyOf(it));
  }
  const seen = new Map();
  const units = [];
  for (const it of rr.items || []) {
    const k = skuSuffix(it.sku || it.asin);
    for (let u = 0; u < qtyOf(it); u++) {
      const n = (seen.get(k) || 0) + 1;
      seen.set(k, n);
      units.push({ key: `${rr.returnRequestId}:${k}#${n}`, item: it, n, unitsOfSku: totals.get(k) });
    }
  }
  return units;
}
