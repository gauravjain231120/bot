// Item count + numbered photos for the four scan pages (Myntra / Amazon, Pack
// / Return): how many pieces the parcel holds, big at the top of the result,
// and a number on every product photo (1, 2, 3 …) so each piece can be
// matched to what's in hand. A product line with quantity 2+ gets the range
// of numbers it covers ("2–3"), so the numbers always add up to the count.

/**
 * Numbers product lines by piece: [{ quantity: 1 }, { quantity: 2 }] →
 * labels ['1', '2–3'], total 3. Missing / bad quantities count as 1; an
 * explicit 0 (a cancelled line) is no piece at all — label null, no number.
 */
export function numberPieces(quantities) {
  let next = 1;
  const labels = quantities.map((q) => {
    if (q === 0 || q === '0') return null;
    const n = Math.max(1, Math.floor(Number(q)) || 1);
    const label = n === 1 ? String(next) : `${next}–${next + n - 1}`;
    next += n;
    return label;
  });
  return { labels, total: next - 1 };
}

/** Big "3 items" banner. `verb` finishes the sentence for 2+: "pack all 3" / "check all 3". */
export function ItemCountBanner({ count, noun = 'parcel', verb }) {
  if (!count) return null;
  const many = count > 1;
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 14,
        padding: '10px 14px',
        borderRadius: 12,
        border: `2px solid ${many ? 'var(--accent)' : 'var(--border)'}`,
        background: many ? 'var(--accent-soft)' : 'var(--surface-2)',
      }}
    >
      <span style={{ fontSize: '3rem', fontWeight: 800, lineHeight: 1, color: many ? 'var(--accent)' : 'var(--text)' }}>{count}</span>
      <span style={{ fontSize: '1.05rem', fontWeight: 700, lineHeight: 1.3 }}>
        item{many ? 's' : ''} in this {noun}
        {many && verb && <span style={{ display: 'block', fontSize: '0.85rem', fontWeight: 600, color: 'var(--text-dim)' }}>{verb} all {count}</span>}
      </span>
    </div>
  );
}

/** Product photo with its piece number in the corner (a numbered box if there's no photo). */
export function NumberedImage({ src, label }) {
  const badge = label == null ? null : (
    <span
      style={{
        position: 'absolute',
        top: 6,
        left: 6,
        minWidth: 34,
        height: 34,
        padding: '0 8px',
        borderRadius: 17,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'var(--accent)',
        color: '#fff',
        fontSize: '1.15rem',
        fontWeight: 800,
        boxShadow: '0 1px 4px rgba(0,0,0,0.35)',
      }}
    >
      {label}
    </span>
  );
  if (!src) {
    if (!badge) return null;
    return (
      <div style={{ position: 'relative', width: 60, height: 60, flexShrink: 0, borderRadius: 10, background: 'var(--surface-2)' }}>
        {badge}
      </div>
    );
  }
  return (
    <div style={{ position: 'relative', flexShrink: 0, alignSelf: 'flex-start' }}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={src}
        alt=""
        style={{ display: 'block', width: 170, maxWidth: '38vw', height: 'auto', maxHeight: 250, borderRadius: 10, objectFit: 'contain' }}
      />
      {badge}
    </div>
  );
}
