export function timeAgo(iso) {
  if (!iso) return 'never';
  const diffSec = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
  if (diffSec < 5) return 'just now';
  if (diffSec < 60) return `${diffSec}s ago`;
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  return new Date(iso).toLocaleDateString();
}

export function formatMinutes(mins) {
  if (mins == null) return '—';
  if (mins < 60) return `${mins}m`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m ? `${h}h ${m}m` : `${h}h`;
}

// Whichever of the 4 OTC slots actually have a code — the empty ones just
// aren't shown, rather than padding the card with four "—" lines.
export function otcLines(values) {
  if (!values) return [];
  const labels = [
    ['pickupMys', 'Pickup MYS'],
    ['pickupMye', 'Pickup MYE'],
    ['returnMys', 'Return MYS'],
    ['returnMye', 'Return MYE'],
  ];
  return labels.filter(([key]) => values[key]).map(([key, label]) => `${label}: ${values[key]}`);
}

// Same set stock-manager's own /api/register expects for a RETURN entry —
// duplicated here since this app never imports stock-manager's codebase
// directly (same boundary as BUNDLE_CODE_MAP in lib/stock.js).
export const RETURN_CONDITIONS = ['GOOD', 'USED', 'FAKED', 'WRONG', 'DEFECTIVE'];
export const RETURN_CONDITION_LABELS = { GOOD: 'Good', USED: 'Used', FAKED: 'Faked', WRONG: 'Wrong item', DEFECTIVE: 'Defective' };

// "13:05" (24-hour, as stored) -> "1:05 pm" — the OTC check window's display.
export function formatHm(hm) {
  const m = /^(\d{2}):(\d{2})$/.exec(String(hm || ''));
  if (!m) return hm || '';
  const h = Number(m[1]);
  return `${h % 12 || 12}:${m[2]} ${h < 12 ? 'am' : 'pm'}`;
}

// "28 Sept, 1:28 pm" in India time — for a saved moment on a page.
export function formatDateTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
}
