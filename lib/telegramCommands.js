const axios = require('axios');
const { escapeHtml } = require('./html');

const STOCK_MANAGER_URL = process.env.STOCK_MANAGER_URL || 'https://stock-manager-niko.vercel.app';

// Telegram caps a text message at 4096 chars — stay well under it so a long
// queue never fails to send instead of just trimming.
const MAX_LEN = 3500;

// `totalCount` = list lines in `text` (every caller passes the full list), so
// what was cut off is counted from the lines actually dropped — the old
// version subtracted the full count from itself and always said "…and 0 more".
function truncate(text, totalCount) {
  if (text.length <= MAX_LEN) return text;
  const cut = text.slice(0, MAX_LEN);
  const kept = cut.slice(0, cut.lastIndexOf('\n'));
  const droppedLines = text.slice(kept.length).split('\n').filter((l) => l.trim()).length;
  const more = Math.min(totalCount, droppedLines);
  return `${kept}\n\n…and ${more} more.`;
}

async function fetchQueueSummary() {
  const token = process.env.STOCK_MANAGER_AUTH_TOKEN;
  const res = await axios.get(`${STOCK_MANAGER_URL}/api/pending/summary`, {
    headers: { Cookie: `auth=${token}` },
    timeout: 20000,
  });
  return res.data;
}

const PLATFORM_LABELS = { AMAZON: 'Amazon', FLIPKART: 'Flipkart', MYNTRA: 'Myntra', OWN_SITE: 'Own site' };
function platformLabel(channel) {
  return PLATFORM_LABELS[channel] || channel || 'Unknown';
}

// A ship-by date as an IST calendar day (YYYY-MM-DD), same convention the
// website's own date filter uses — a UTC-based comparison could put an item
// on the wrong side of midnight for an IST seller.
function shipByDayKeyIst(iso) {
  if (!iso) return '';
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date(iso));
}

const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };

// Parses "5aug", "10dec", "8nov" (day + month name, any length/case) into a
// YYYY-MM-DD string, assuming the current IST year — never null-checks the
// year itself since ship dates are always near-term in this business.
function parseShortDate(text) {
  const m = /^(\d{1,2})\s*([a-zA-Z]{3,})$/.exec((text || '').trim());
  if (!m) return null;
  const day = parseInt(m[1], 10);
  const month = MONTHS[m[2].toLowerCase().slice(0, 3)];
  if (!month || day < 1 || day > 31) return null;
  const year = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric' }).format(new Date());
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function dateSuffix(dateFilter) {
  return dateFilter ? ` — ${dateFilter}` : '';
}

/** "2026-09-22" -> "22-09-2026" — the DD-MM-YYYY format Myntra's packed-orders endpoint wants. */
function toDMY(ymd) {
  const [y, m, d] = ymd.split('-');
  return `${d}-${m}-${y}`;
}

/** Today's IST calendar day as YYYY-MM-DD — same convention as shipByDayKeyIst, just for "now". */
function todayIst() {
  return shipByDayKeyIst(new Date().toISOString());
}

function formatPackedCount(count, dayKey) {
  return `📦 <b>Packed — ${dayKey}</b>\n\n${count} order${count === 1 ? '' : 's'} packed.`;
}

function otcLine(label, value) {
  return `${label}: <b>${escapeHtml(value || '—')}</b>`;
}

// The packets for today's pickup (checkOtc.js pickupPackets: { total, mys,
// mye, other, capped }, or { error } when the packed list couldn't be read):
// the total right under the title, each courier's count in brackets after
// its pickup code. Only the automatic OTC alert passes it.
function packedLine(packed) {
  if (!packed) return '';
  if (packed.error) return `\n📦 Packed: <i>couldn't read Myntra's packed list</i>`;
  return `\n📦 <b>Packed: ${packed.total}${packed.capped ? '+' : ''}</b>${packed.other ? ` (${packed.other} other)` : ''}`;
}

// Same message shape checkOtc.js's own automatic alert sends — shared here
// so /otc and /otcall (an on-demand live look, any time) render the codes
// identically to the automatic OTC-window alert instead of drifting into
// their own format (the packed count is the automatic alert's only).
function formatOtcStatus(values, packed = null) {
  const count = (n) => (packed && !packed.error ? ` (${n})` : '');
  return (
    `🔑 <b>Pickup / Return OTC</b>${packedLine(packed)}\n\n` +
    `${otcLine('Pickup MYS', values.pickupMys)}${count(packed && packed.mys)}\n` +
    `${otcLine('Pickup MYE', values.pickupMye)}${count(packed && packed.mye)}\n\n` +
    `${otcLine('Return MYS', values.returnMys)}\n` +
    `${otcLine('Return MYE', values.returnMye)}`
  );
}

function formatShipList(summary, dateFilter) {
  const rows = dateFilter ? summary.rows.filter((r) => shipByDayKeyIst(r.shipByAt) === dateFilter) : summary.rows;
  if (rows.length === 0) {
    return dateFilter ? `📦 Nothing shipping on ${dateFilter}.` : '📦 Ready to Ship is empty right now.';
  }
  const units = rows.reduce((a, r) => a + r.qty, 0);
  const lines = rows.map((r, i) => {
    const qty = r.qty > 1 ? ` (${r.qty})` : '';
    const flag = r.short ? ' — out of stock' : '';
    return `${i + 1}. ${escapeHtml(r.name)}${qty}, ${escapeHtml(platformLabel(r.channel))}${flag}`;
  });
  const body = `📦 <b>Ready to Ship${dateSuffix(dateFilter)}</b> — ${rows.length} order${rows.length === 1 ? '' : 's'}, ${units} unit${units === 1 ? '' : 's'}\n\n${lines.join('\n')}`;
  return truncate(body, rows.length);
}

// Same layout as formatShipList but narrowed to one platform — the platform
// label is dropped per line since the whole list is already that platform.
function formatPlatformList(summary, channel, label, dateFilter) {
  const rows = summary.rows.filter(
    (r) => r.channel === channel && (!dateFilter || shipByDayKeyIst(r.shipByAt) === dateFilter)
  );
  if (rows.length === 0) {
    return `📦 No ${label} orders${dateFilter ? ` on ${dateFilter}` : ''} in Ready to Ship right now.`;
  }
  const units = rows.reduce((a, r) => a + r.qty, 0);
  const lines = rows.map((r, i) => {
    const qty = r.qty > 1 ? ` (${r.qty})` : '';
    const flag = r.short ? ' — out of stock' : '';
    return `${i + 1}. ${escapeHtml(r.name)}${qty}${flag}`;
  });
  const body = `📦 <b>${label} — Ready to Ship${dateSuffix(dateFilter)}</b> — ${rows.length} order${rows.length === 1 ? '' : 's'}, ${units} unit${units === 1 ? '' : 's'}\n\n${lines.join('\n')}`;
  return truncate(body, rows.length);
}

// Same as formatPlatformList but narrowed further to items not yet packed
// ("ready" is stock-manager's packed-and-set-aside flag) — the actual
// remaining work for that platform (and, optionally, that date) right now.
function formatPlatformLeftList(summary, channel, label, dateFilter) {
  const rows = summary.rows.filter(
    (r) => r.channel === channel && !r.ready && (!dateFilter || shipByDayKeyIst(r.shipByAt) === dateFilter)
  );
  if (rows.length === 0) {
    return `✅ Nothing left to pack for ${label}${dateFilter ? ` on ${dateFilter}` : ''} right now.`;
  }
  const units = rows.reduce((a, r) => a + r.qty, 0);
  const lines = rows.map((r, i) => {
    const qty = r.qty > 1 ? ` (${r.qty})` : '';
    const flag = r.short ? ' — out of stock' : '';
    return `${i + 1}. ${escapeHtml(r.name)}${qty}${flag}`;
  });
  const body = `📋 <b>${label} — left to pack${dateSuffix(dateFilter)}</b> — ${rows.length} order${rows.length === 1 ? '' : 's'}, ${units} unit${units === 1 ? '' : 's'}\n\n${lines.join('\n')}`;
  return truncate(body, rows.length);
}

// Cross-platform version of formatPlatformLeftList — every order across
// every marketplace that hasn't been packed yet ("ready" is stock-manager's
// packed-and-set-aside flag), not narrowed to one platform. The actual
// remaining packing work right now, full stop.
function formatNotReadyList(summary, dateFilter) {
  const rows = summary.rows.filter(
    (r) => !r.ready && (!dateFilter || shipByDayKeyIst(r.shipByAt) === dateFilter)
  );
  if (rows.length === 0) {
    return `✅ Nothing left to pack${dateFilter ? ` on ${dateFilter}` : ''} right now.`;
  }
  const units = rows.reduce((a, r) => a + r.qty, 0);
  const lines = rows.map((r, i) => {
    const qty = r.qty > 1 ? ` (${r.qty})` : '';
    const flag = r.short ? ' — out of stock' : '';
    return `${i + 1}. ${escapeHtml(r.name)}${qty}, ${escapeHtml(platformLabel(r.channel))}${flag}`;
  });
  const body = `📋 <b>Not ready — left to pack${dateSuffix(dateFilter)}</b> — ${rows.length} order${rows.length === 1 ? '' : 's'}, ${units} unit${units === 1 ? '' : 's'}\n\n${lines.join('\n')}`;
  return truncate(body, rows.length);
}

// The flip side of formatNotReadyList — everything already packed & set
// aside, waiting to actually ship. Same shape as formatShipList but narrowed
// to r.ready === true instead of showing the whole queue.
function formatReadyList(summary, dateFilter) {
  const rows = summary.rows.filter(
    (r) => r.ready && (!dateFilter || shipByDayKeyIst(r.shipByAt) === dateFilter)
  );
  if (rows.length === 0) {
    return `📦 Nothing packed and ready${dateFilter ? ` on ${dateFilter}` : ''} right now.`;
  }
  const units = rows.reduce((a, r) => a + r.qty, 0);
  const lines = rows.map((r, i) => {
    const qty = r.qty > 1 ? ` (${r.qty})` : '';
    const flag = r.short ? ' — out of stock' : '';
    return `${i + 1}. ${escapeHtml(r.name)}${qty}, ${escapeHtml(platformLabel(r.channel))}${flag}`;
  });
  const body = `✅ <b>Ready to ship (packed)${dateSuffix(dateFilter)}</b> — ${rows.length} order${rows.length === 1 ? '' : 's'}, ${units} unit${units === 1 ? '' : 's'}\n\n${lines.join('\n')}`;
  return truncate(body, rows.length);
}

function formatMakeList(summary) {
  const short = summary.rows.filter((r) => r.short);
  if (short.length === 0) return '✅ Nothing out of stock — everything can ship right now.';
  const lines = short.map((r, i) => {
    const need = r.qty - r.free;
    return `${i + 1}. ${escapeHtml(r.name)}${need > 1 ? ` — make ${need}` : ''}`;
  });
  const body = `🔴 <b>Out of stock</b> — ${short.length} item${short.length === 1 ? '' : 's'} to make\n\n${lines.join('\n')}`;
  return truncate(body, short.length);
}

module.exports = {
  fetchQueueSummary,
  formatShipList,
  formatMakeList,
  formatPlatformList,
  formatPlatformLeftList,
  formatReadyList,
  formatNotReadyList,
  formatPackedCount,
  formatOtcStatus,
  parseShortDate,
  toDMY,
  todayIst,
};
