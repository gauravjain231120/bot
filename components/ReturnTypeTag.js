'use client';

// "Customer return" / "RTO" / "Unknown" tag on the Myntra Return and Amazon
// Return scan pages — the same value is stored on the stock-manager return
// row when the item is added (returnType: CUSTOMER / RTO / UNKNOWN).
const STYLES = {
  CUSTOMER: { label: 'Customer return', color: '#0369a1', background: 'rgba(14, 165, 233, 0.14)' },
  RTO: { label: 'RTO', color: '#c2410c', background: 'rgba(249, 115, 22, 0.16)' },
  UNKNOWN: { label: 'Unknown', color: 'var(--text-dim)', background: 'var(--surface-2)' },
};

export const RETURN_TYPE_HINTS = {
  CUSTOMER: 'The customer received it and sent it back.',
  RTO: 'Never reached the customer and came back to you (return to origin).',
  UNKNOWN: "Couldn't tell whether this is a customer return or an RTO.",
};

export function ReturnTypeTag({ type }) {
  const s = STYLES[type] || STYLES.UNKNOWN;
  return (
    <span
      title={RETURN_TYPE_HINTS[type] || RETURN_TYPE_HINTS.UNKNOWN}
      style={{ display: 'inline-block', fontSize: '0.78rem', fontWeight: 700, borderRadius: 6, padding: '2px 8px', color: s.color, background: s.background }}
    >
      {s.label}
    </span>
  );
}
