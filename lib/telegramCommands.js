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

function formatShipList(summary) {
  if (summary.count === 0) return '📦 Ready to Ship is empty right now.';
  const lines = summary.rows.map((r, i) => {
    const qty = r.qty > 1 ? ` (${r.qty})` : '';
    const flag = r.short ? ' — out of stock' : '';
    return `${i + 1}. ${r.name}${qty}, ${platformLabel(r.channel)}${flag}`;
  });
  const body = `📦 <b>Ready to Ship</b> — ${summary.count} order${summary.count === 1 ? '' : 's'}, ${summary.units} unit${summary.units === 1 ? '' : 's'}\n\n${lines.join('\n')}`;
  return truncate(body, summary.count, lines.length);
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

module.exports = { fetchQueueSummary, formatShipList, formatMakeList };
