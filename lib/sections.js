// What each dashboard account may open. An Owner opens everything (Team —
// who can log in and what they can open — is Owner-only, always). A Viewer
// opens only the sections the Owner ticked for them on the Team page.
//
// Shared by the browser (sidebar, page guard, Team page) and the server
// (lib/access.js — every API route checks it, so a section left unticked is
// closed, not just hidden). Pure data + functions, no imports.

export const SECTIONS = [
  { key: 'overview', label: 'Overview', hint: 'status, open orders, OTC codes, Myntra packed', paths: ['/', '/orders'] },
  { key: 'myntraReturn', label: 'Myntra Return', paths: ['/returns'] },
  { key: 'myntraPack', label: 'Myntra Pack', paths: ['/packed'] },
  { key: 'myntraCancel', label: 'Myntra Cancel', hint: 'mark a packed parcel cancelled — puts its stock back', paths: ['/myntra-cancel'] },
  { key: 'amazonPack', label: 'Amazon Pack', paths: ['/amazon-packed'] },
  { key: 'amazonReturn', label: 'Amazon Return', paths: ['/amazon-returns'] },
  { key: 'sessions', label: 'Sessions', hint: 'paste a marketplace session', paths: ['/sessions'] },
  { key: 'recipients', label: 'Recipients', hint: 'who gets the Telegram alerts', paths: ['/recipients'] },
  { key: 'spf', label: 'SPF Status', paths: ['/spf-status'] },
  { key: 'controls', label: 'Start / Stop / Check now', hint: 'the buttons at the top' },
];

export const SECTION_KEYS = SECTIONS.map((s) => s.key);

// Owner-only, never given to a Viewer.
export const TEAM_SECTION = 'team';
const TEAM_PATHS = ['/team'];

// A Viewer saved before per-person access existed has no list: what Viewers
// could use then (Sessions showed, but saving one was already Owner-only;
// Recipients, Team and SPF Status were Owner-only).
export const DEFAULT_VIEWER_SECTIONS = ['overview', 'myntraReturn', 'myntraPack', 'amazonPack', 'amazonReturn', 'controls'];

/** Only known keys, each once, in the order above. */
export function cleanSections(list) {
  const want = new Set(Array.isArray(list) ? list.map(String) : []);
  return SECTION_KEYS.filter((k) => want.has(k));
}

/** The sections `account` ({ role, sections }) may open. */
export function effectiveSections(account) {
  if (!account) return [];
  if (account.role === 'OWNER') return [...SECTION_KEYS, TEAM_SECTION];
  return Array.isArray(account.sections) ? cleanSections(account.sections) : [...DEFAULT_VIEWER_SECTIONS];
}

export function canAccess(account, key) {
  return effectiveSections(account).includes(key);
}

/** The section a page path belongs to, or null (a page open to every account). */
export function sectionForPath(pathname) {
  const path = String(pathname || '/').replace(/\/+$/, '') || '/';
  if (TEAM_PATHS.includes(path)) return TEAM_SECTION;
  const hit = SECTIONS.find((s) => (s.paths || []).includes(path));
  return hit ? hit.key : null;
}

/** First page this account may open (where to send it from one it can't). */
export function firstAllowedPath(account) {
  const allowed = effectiveSections(account);
  for (const s of SECTIONS) if (s.paths && allowed.includes(s.key)) return s.paths[0];
  return allowed.includes(TEAM_SECTION) ? TEAM_PATHS[0] : null;
}
