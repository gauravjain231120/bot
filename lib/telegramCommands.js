const axios = require('axios');

const STOCK_MANAGER_URL = process.env.STOCK_MANAGER_URL || 'https://stock-manager-niko.vercel.app';

// Telegram caps a text message at 4096 chars — stay well under it so a long
// queue never fails to send instead of just trimming.
const MAX_LEN = 3500;

function truncate(text, totalCount, shownCount) {
  if (text.length <= MAX_LEN) return text;
  const cut = text.slice(0, MAX_LEN);
  const lastBreak = cut.lastIndexOf('\n');
  return `${cut.slice(0, lastBreak)}\n\n…and ${totalCount - shownCount} more.`;
}

async function fetchQueueSummary() {
  const token = process.env.STOCK_MANAGER_AUTH_TOKEN;
  const res = await axios.get(`${STOCK_MANAGER_URL}/api/pending/summary`, {
    headers: { Cookie: `auth=${token}` },
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

function formatShipList(summary, dateFilter) {
  const rows = dateFilter ? summary.rows.filter((r) => shipByDayKeyIst(r.shipByAt) === dateFilter) : summary.rows;
  if (rows.length === 0) {
    return dateFilter ? `📦 Nothing shipping on ${dateFilter}.` : '📦 Ready to Ship is empty right now.';
  }
  const units = rows.reduce((a, r) => a + r.qty, 0);
  const lines = rows.map((r, i) => {
    const qty = r.qty > 1 ? ` (${r.qty})` : '';
    const flag = r.short ? ' — out of stock' : '';
    return `${i + 1}. ${r.name}${qty}, ${platformLabel(r.channel)}${flag}`;
  });
  const body = `📦 <b>Ready to Ship${dateSuffix(dateFilter)}</b> — ${rows.length} order${rows.length === 1 ? '' : 's'}, ${units} unit${units === 1 ? '' : 's'}\n\n${lines.join('\n')}`;
  return truncate(body, rows.length, lines.length);
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
    return `${i + 1}. ${r.name}${qty}${flag}`;
  });
  const body = `📦 <b>${label} — Ready to Ship${dateSuffix(dateFilter)}</b> — ${rows.length} order${rows.length === 1 ? '' : 's'}, ${units} unit${units === 1 ? '' : 's'}\n\n${lines.join('\n')}`;
  return truncate(body, rows.length, lines.length);
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
    return `${i + 1}. ${r.name}${qty}${flag}`;
  });
  const body = `📋 <b>${label} — left to pack${dateSuffix(dateFilter)}</b> — ${rows.length} order${rows.length === 1 ? '' : 's'}, ${units} unit${units === 1 ? '' : 's'}\n\n${lines.join('\n')}`;
  return truncate(body, rows.length, lines.length);
}

function formatMakeList(summary) {
  const short = summary.rows.filter((r) => r.short);
  if (short.length === 0) return '✅ Nothing out of stock — everything can ship right now.';
  const lines = short.map((r, i) => {
    const need = r.qty - r.free;
    return `${i + 1}. ${r.name}${need > 1 ? ` — make ${need}` : ''}`;
  });
  const body = `🔴 <b>Out of stock</b> — ${short.length} item${short.length === 1 ? '' : 's'} to make\n\n${lines.join('\n')}`;
  return truncate(body, short.length, lines.length);
}

module.exports = {
  fetchQueueSummary,
  formatShipList,
  formatMakeList,
  formatPlatformList,
  formatPlatformLeftList,
  parseShortDate,
};
