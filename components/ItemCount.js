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

/**
 * Big "3 items" banner. `verb` finishes the sentence for 2+: "pack all 3" /
 * "check all 3". `cancelled`: items on it that are cancelled — nothing left to
 * pack is a red "Cancelled — do not pack"; some left adds "+ N cancelled".
 */
export function ItemCountBanner({ count, noun = 'parcel', verb, cancelled = 0 }) {
  if (!count && cancelled > 0) {
    return (
      <div
        role="alert"
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 14,
          padding: '10px 14px',
          borderRadius: 12,
          border: '2px solid var(--bad)',
          background: 'var(--bad-soft)',
          color: 'var(--bad)',
        }}
      >
        <span aria-hidden="true" style={{ fontSize: '3rem', fontWeight: 900, lineHeight: 1 }}>✕</span>
        <span style={{ fontSize: '1.15rem', fontWeight: 800, lineHeight: 1.3 }}>
          Cancelled — do not pack
          <span style={{ display: 'block', fontSize: '0.85rem', fontWeight: 600 }}>
            {cancelled === 1 ? 'The item in this ' + noun + ' is cancelled' : `All ${cancelled} items in this ${noun} are cancelled`}
          </span>
        </span>
      </div>
    );
  }
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
        item{many ? 's' : ''} {cancelled > 0 ? 'to pack' : `in this ${noun}`}
        {many && verb && <span style={{ display: 'block', fontSize: '0.85rem', fontWeight: 600, color: 'var(--text-dim)' }}>{verb} all {count}</span>}
        {cancelled > 0 && (
          <span style={{ display: 'block', fontSize: '0.85rem', fontWeight: 700, color: 'var(--bad)' }}>
            ✕ + {cancelled} cancelled — leave {cancelled === 1 ? 'it' : 'them'} out
          </span>
        )}
      </span>
    </div>
  );
}

// A big red ✕ over the whole photo and a CANCELLED tag — the piece is not to
// be packed. Lines are drawn corner to corner at a fixed thickness whatever
// the photo's shape.
function CancelledMark() {
  return (
    <div
      role="img"
      aria-label="Cancelled"
      style={{
        position: 'absolute',
        inset: 0,
        borderRadius: 10,
        background: 'rgba(220, 38, 38, 0.16)',
        border: '3px solid #dc2626',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        pointerEvents: 'none',
        overflow: 'hidden',
      }}
    >
      <svg viewBox="0 0 100 100" preserveAspectRatio="none" style={{ position: 'absolute', inset: 0, width: '100%', height: '100%' }}>
        <line x1="6" y1="6" x2="94" y2="94" stroke="#dc2626" strokeWidth="10" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
        <line x1="94" y1="6" x2="6" y2="94" stroke="#dc2626" strokeWidth="10" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
      </svg>
      <span
        style={{
          position: 'relative',
          background: '#dc2626',
          color: '#fff',
          fontWeight: 900,
          fontSize: '0.95rem',
          letterSpacing: 1,
          padding: '3px 10px',
          borderRadius: 6,
          boxShadow: '0 1px 6px rgba(0,0,0,0.4)',
        }}
      >
        CANCELLED
      </span>
    </div>
  );
}

/**
 * Product photo with its piece number in the corner (a numbered box if there's
 * no photo). `cancelled`: the red ✕ across it instead (no number — it isn't a
 * piece to pack).
 */
export function NumberedImage({ src, label, cancelled = false }) {
  const badge = label == null || cancelled ? null : (
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
    if (!badge && !cancelled) return null;
    return (
      <div style={{ position: 'relative', width: cancelled ? 110 : 60, height: cancelled ? 110 : 60, flexShrink: 0, borderRadius: 10, background: 'var(--surface-2)' }}>
        {badge}
        {cancelled && <CancelledMark />}
      </div>
    );
  }
  return (
    <div style={{ position: 'relative', flexShrink: 0, alignSelf: 'flex-start' }}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={src}
        alt=""
        style={{
          display: 'block',
          width: 170,
          maxWidth: '38vw',
          height: 'auto',
          maxHeight: 250,
          borderRadius: 10,
          objectFit: 'contain',
          ...(cancelled ? { filter: 'grayscale(0.6)', opacity: 0.75 } : {}),
        }}
      />
      {badge}
      {cancelled && <CancelledMark />}
    </div>
  );
}
