const axios = require('axios');
const { formatIST } = require('./dates');
const { persistAmazonCookies } = require('./myntraCookies');
const { escapeHtml } = require('./html');

// Amazon's fraud/bot detection occasionally blocks one specific query shape
// with a 403 while the exact same session succeeds on a different one seconds
// later (observed: cancellation search 403s while the unshipped search on the
// same session works fine) — a real session expiry would fail everything, not
// just one query. A short retry absorbs that kind of one-off block instead of
// surfacing it as an error and waiting a full cycle to recover.
//
// Not retried: a real sign-out — 401, or 403 with Amazon's own body
// `{"reason":"sign_in"}` (verified live 2026-09-23). Retrying those only
// burned 2 extra calls (and ~8s) on every check for the whole outage.
//
// Every successful response also refreshes the stored session's cookies:
// Amazon re-issues `session-token` on each call, and the bot used to throw
// that away (lib/myntraCookies.js persistAmazonCookies).
// Amazon's real "you're signed out" answers: 401, a 403 {"reason":"sign_in"},
// or a sign-in HTML page. Any other 403 is usually Amazon's one-off request
// block, which says nothing about the login (see checkAmazonOrders.js).
function isSignIn(err) {
  const r = err && err.response;
  if (!r) return false;
  if (r.status === 401) return true;
  if (r.status !== 403) return false;
  const d = r.data;
  if (d && typeof d === 'object') return /^sign.?in$/i.test(String(d.reason || ''));
  return looksLikeSignInPage(d);
}

// Positive evidence only: a captcha / robot-check page often links to sign-in
// too, and reading it as "signed out" raised a false expiry — and made the
// extension hold back the (good) login for 2 hours.
function looksLikeSignInPage(body) {
  const html = String(body || '').slice(0, 20000);
  if (/captcha|robot check|validateCaptcha/i.test(html)) return false;
  return /ap\/signin|name=["']signIn["']|<title>[^<]*sign[\s-]?in/i.test(html);
}

// No Amazon call may hang a cron run.
const AMAZON_TIMEOUT_MS = 20000;

async function getWithRetry(url, headers, retries = 2, delayMs = 4000, timeoutMs = AMAZON_TIMEOUT_MS) {
  try {
    const res = await axios.get(url, { headers, timeout: timeoutMs });
    await persistAmazonCookies(headers, res);
    return res;
  } catch (err) {
    const status = err.response && err.response.status;
    if (isSignIn(err)) throw err;
    // No answer at all (connection reset / timeout) is retried too — it says
    // nothing about the session.
    const networkError = !err.response && err.code !== 'ERR_CANCELED';
    if (retries > 0 && (networkError || status === 403 || status === 429 || (status && status >= 500))) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      return getWithRetry(url, headers, retries - 1, delayMs, timeoutMs);
    }
    throw err;
  }
}

// Amazon Seller Central has no public order-alert API either — this replays the
// same internal request the orders dashboard itself makes. Unlike Myntra, this
// endpoint already returns full item detail (image, SKU, title) in one call.
function searchUrl(program, offset, limit) {
  const params = new URLSearchParams({
    limit: String(limit),
    offset: String(offset),
    sort: 'ship_by_asc',
    'date-range': 'last-90',
    fulfillmentType: 'mfn',
    orderStatus: 'unshipped',
    program,
    shipByDate: 'all',
    forceOrdersTableRefreshTrigger: 'false',
  });
  return `https://sellercentral.amazon.in/orders-api/search?${params.toString()}`;
}

// Same search endpoint, just orderStatus=canceled instead of unshipped —
// Amazon's own "Canceled orders" tab uses this identical request shape.
function cancelledSearchUrl(program, offset, limit) {
  const params = new URLSearchParams({
    limit: String(limit),
    offset: String(offset),
    sort: 'ship_by_desc',
    'date-range': 'last-90',
    fulfillmentType: 'mfn',
    orderStatus: 'canceled',
    program,
    forceOrdersTableRefreshTrigger: 'false',
  });
  return `https://sellercentral.amazon.in/orders-api/search?${params.toString()}`;
}

// A 200 whose body isn't the orders JSON is Amazon's sign-in page. Without
// this check it read as "0 orders" — no error, no session-expired alert, new
// orders silently missed. Thrown as a 401 so every caller's existing
// session-expired handling covers it.
//
// Only a real sign-in page (or JSON saying sign_in) counts as signed out; any
// other odd answer — a captcha, a maintenance page, a changed JSON shape — is
// a temporary error (502): retried, and alerted if it lasts, but never read as
// an expired login.
function ordersFrom(res) {
  const d = res && res.data;
  if (d && typeof d === 'object' && Array.isArray(d.orders)) return d.orders;
  const signedOut = (d && typeof d === 'object' && /^sign.?in$/i.test(String(d.reason || ''))) || (typeof d === 'string' && looksLikeSignInPage(d));
  const err = new Error(signedOut ? 'Amazon returned a sign-in page instead of orders' : 'Amazon returned an unexpected answer instead of orders');
  err.response = { status: signedOut ? 401 : 502, data: typeof d === 'string' ? d.slice(0, 500) : d };
  throw err;
}

const PAGE_SIZE = 100;
const MAX_PAGES = 20; // safety cap (≤2000 orders) against any pagination-math edge case

// A hardcoded limit=15 with no pagination silently dropped every order past
// the 15th once a seller had more than that many open at once — confirmed
// live: the same session that returned 15 orders at limit=15 returned all
// 18 real ones at limit=100, with a `total` field in the response matching
// exactly. This is very likely what caused the earlier "orders invisible to
// the poller" mystery. Paginate off that `total` field instead of trusting
// one page to contain everything, however large it currently looks.
async function fetchAllPages(urlBuilder, headers) {
  let offset = 0;
  let all = [];
  for (let page = 0; page < MAX_PAGES; page++) {
    const res = await getWithRetry(urlBuilder(offset, PAGE_SIZE), headers);
    const orders = ordersFrom(res);
    all = all.concat(orders);
    const total = typeof res.data.total === 'number' ? res.data.total : all.length;
    offset += orders.length;
    if (orders.length === 0 || offset >= total) break;
  }
  // Offset paging over a list that changes between pages can repeat an order —
  // one entry per order id (a repeat would be a second alert).
  const seen = new Set();
  return all.filter((o) => {
    const id = String(o && o.amazonOrderId);
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

// Cheapest possible "does this session work?" check — ONE search request
// with limit=1 (instead of fetchUnshippedOrders' 2 programs x every page).
// Used to test a synced session before the bot switches to it.
async function probeAmazonSession(headers) {
  // 12 s + 2 s + 12 s worst case — inside the sync/paste routes' 30 s limit.
  ordersFrom(await getWithRetry(searchUrl('easyship', 0, 1), headers, 1, 2000, 12000));
  return true;
}

// Easy Ship only. This account doesn't use self-ship (0 orders in 365 days
// vs 704 Easy Ship, verified 2026-09-23), and searching it on every check was
// half of all Amazon calls — removed on the seller's instruction. If
// self-ship is ever used, add 'selfship' back here: every fetch below takes
// its programs from this list.
const ALL_PROGRAMS = ['easyship'];

// { easyship: [...] } — one entry per program searched (see ALL_PROGRAMS).
async function fetchUnshippedByProgram(headers, programs = ALL_PROGRAMS) {
  const results = await Promise.all(
    programs.map((program) => fetchAllPages((offset, limit) => searchUrl(program, offset, limit), headers))
  );
  return Object.fromEntries(programs.map((p, i) => [p, results[i]]));
}

async function fetchUnshippedOrders(headers, programs = ALL_PROGRAMS) {
  return Object.values(await fetchUnshippedByProgram(headers, programs)).flat();
}

// Deliberately NOT paginated like fetchUnshippedOrders — even though this
// endpoint is bounded to the last 90 days, that's still enough history to
// contain far more than a handful of old cancellations the poller never
// marked seen (confirmed: this one call alone surfaced ~95, all flooding out
// as individual alerts in one go, for the same reason as Myntra's — see
// fetchCancelledOrders in lib/myntra.js). A single bounded page is enough
// headroom for "anything cancelled since the last ~30-minute check."
async function fetchCancelledByProgram(headers, programs = ALL_PROGRAMS) {
  const results = await Promise.all(
    programs.map((program) => getWithRetry(cancelledSearchUrl(program, 0, 50), headers).then(ordersFrom))
  );
  return Object.fromEntries(programs.map((p, i) => [p, results[i]]));
}

async function fetchCancelledOrders(headers, programs = ALL_PROGRAMS) {
  return Object.values(await fetchCancelledByProgram(headers, programs)).flat();
}

// Amazon's search response returns small thumbnails (e.g. "..._SR135,135_.jpg") —
// swap the size modifier for a much larger one. Amazon's CDN clamps this to
// whatever the listing's master image actually is (currently ~373x500 across this
// catalog) — asking for more costs nothing and helps automatically if any listing
// later gets a higher-res image uploaded in Seller Central.
function pickAmazonImage(item) {
  if (!item.imageUrl) return null;
  const url = item.imageUrl.replace(/^http:\/\//, 'https://');
  return url.replace(/\._[A-Za-z0-9,_]+_\.(\w+)$/, '._SL1500_.$1');
}

// Amazon's date fields are epoch seconds (with fractional milliseconds), not epoch ms.
function amazonOrderDateMs(order) {
  return order.orderDate ? Math.round(order.orderDate * 1000) : null;
}

function amazonShipByDateMs(order) {
  return order.latestShipDate ? Math.round(order.latestShipDate * 1000) : null;
}

// Sums quantities for any line items sharing the same SKU within one order
// (rare, but possible) so the rest of the pipeline sees one row per SKU with
// its true total quantity, instead of double-submitting the same SKU+order.
//
// `qty` is what's still to ship: ordered minus any units the buyer already
// cancelled (a partly cancelled order used to reserve — and alert — the
// cancelled units too); `cancelledQty` is kept for the cancel sweep's baseline.
function groupAmazonItemsBySku(orderItems) {
  const bySku = new Map();
  for (const item of orderItems || []) {
    const sku = item.sellerSku;
    const ordered = item.quantityOrdered || 1;
    const cancelled = Math.min(ordered, Math.max(0, Number(item.quantityCanceled) || 0));
    const existing = bySku.get(sku);
    if (existing) {
      existing.qty += ordered - cancelled;
      existing.cancelledQty += cancelled;
    } else {
      bySku.set(sku, { ...item, qty: ordered - cancelled, cancelledQty: cancelled });
    }
  }
  return [...bySku.values()];
}

// Same idea as groupAmazonItemsBySku but for the cancelled-orders search,
// which reports quantityCanceled rather than quantityOrdered.
function groupAmazonCancelledItemsBySku(orderItems) {
  const bySku = new Map();
  for (const item of orderItems || []) {
    const sku = item.sellerSku;
    // A cancelled order's line without a cancelled count: the whole line.
    const qty = item.quantityCanceled || item.quantityOrdered || 1;
    const existing = bySku.get(sku);
    if (existing) existing.qty += qty;
    else bySku.set(sku, { ...item, qty });
  }
  return [...bySku.values()];
}

// Amazon's order-search response has no structured size/color fields — unlike
// Myntra, they're only present inside the title text (e.g. "... (Rose Red) - XXL"
// or "... - Grey - XS") and, for size, often as the SKU's last segment too.
const SIZE_TOKENS = ['XXXL', '3XL', 'XXL', 'XL', 'XS', 'L', 'M', 'S'];
const SIZE_RE = new RegExp(`-\\s*(${SIZE_TOKENS.join('|')})\\s*$`, 'i');

function sizeFromSku(sku) {
  if (!sku) return null;
  const last = sku.split('-').pop().toUpperCase();
  return SIZE_TOKENS.includes(last) ? last : null;
}

function extractVariant(item) {
  const title = (item.productName || item.extendedTitle || '').trim();
  let remaining = title;
  let size = null;

  const sizeMatch = remaining.match(SIZE_RE);
  if (sizeMatch) {
    size = sizeMatch[1].toUpperCase();
    remaining = remaining.slice(0, sizeMatch.index).trim();
  } else {
    size = sizeFromSku(item.sellerSku);
  }

  let color = null;
  const parenMatch = remaining.match(/\(([^()]+)\)\s*$/);
  if (parenMatch) {
    color = parenMatch[1].trim();
  } else {
    const dashMatch = remaining.match(/-\s*([A-Za-z ]{2,24})\s*$/);
    if (dashMatch) color = dashMatch[1].trim();
  }

  return { size, color };
}

function formatAmazonCancelAlert(order) {
  const orderDate = formatIST(amazonOrderDateMs(order));
  const qty = (order.orderItems || []).reduce((sum, item) => sum + (item.quantityCanceled || 0), 0);
  return (
    `❌❌❌❌ <b>Amazon order cancelled</b>\n` +
    `Order ID: <code>${escapeHtml(order.amazonOrderId)}</code>\n` +
    `Qty: ${qty || '?'}\n` +
    `Placed: ${orderDate}`
  );
}

// Header for the richer cancel alert (photo + category) — the cancelled-orders
// search already returns full item detail inline, unlike Myntra, so no extra
// fetch is needed before building this. The quadruple ❌ is deliberate — a
// packer skimming a photo album needs this to read as "STOP, do not ship" at
// a glance, not blend in with a normal order alert.
function formatAmazonCancelHeader(order, itemCount = 1) {
  const orderDate = formatIST(amazonOrderDateMs(order));
  const multiLine = itemCount > 1 ? `🔀 <b>MULTI ORDER</b> (${itemCount} items)\n` : '';
  return (
    `❌❌❌❌ <b>Amazon order cancelled</b>\n` +
    multiLine +
    `Order ID: <code>${escapeHtml(order.amazonOrderId)}</code>\n` +
    `Placed: ${orderDate}`
  );
}

function formatAmazonAlert(order) {
  const orderDate = formatIST(amazonOrderDateMs(order));
  const shipBy = formatIST(amazonShipByDateMs(order));
  const itemCount = (order.orderItems || []).length;
  return (
    `📦 <b>New Amazon order</b>\n` +
    `Order ID: <code>${escapeHtml(order.amazonOrderId)}</code>\n` +
    `Items: ${itemCount}\n` +
    `Placed: ${orderDate}\n` +
    `Ship by: ${shipBy}`
  );
}

// Sent once per order, ahead of one caption per unique SKU — so a multi-item
// order reads as one grouped alert instead of repeating Order ID/Placed/Ship by
// on every item.
function formatAmazonOrderHeader(order, itemCount = 1) {
  const orderDate = formatIST(amazonOrderDateMs(order));
  const shipBy = formatIST(amazonShipByDateMs(order));
  const multiLine = itemCount > 1 ? `🔀 <b>MULTI ORDER</b> (${itemCount} items)\n` : '';
  return (
    `📦 <b>New Amazon order</b>\n` +
    multiLine +
    `Order ID: <code>${escapeHtml(order.amazonOrderId)}</code>\n` +
    `Placed: ${orderDate}\n` +
    `Ship by: ${shipBy}`
  );
}

function formatAmazonItemCaption(item, stockLine = '', category = '') {
  const { size, color } = extractVariant(item);
  const variantLine = size || color ? `Size: ${escapeHtml(size || '?')}${color ? ` | Color: ${escapeHtml(color)}` : ''}\n` : '';
  const categoryLine = category ? `Category: ${escapeHtml(category)}\n` : '';
  return (
    categoryLine +
    `SKU: <code>${escapeHtml(item.sellerSku || '?')}</code>\n` +
    variantLine +
    `Qty: ${escapeHtml(item.qty ?? 1)}\n` +
    stockLine
  ).trim();
}

module.exports = {
  isSignIn,
  fetchUnshippedOrders,
  fetchUnshippedByProgram,
  fetchCancelledByProgram,
  probeAmazonSession,
  fetchCancelledOrders,
  pickAmazonImage,
  amazonOrderDateMs,
  amazonShipByDateMs,
  extractVariant,
  groupAmazonItemsBySku,
  groupAmazonCancelledItemsBySku,
  formatAmazonAlert,
  formatAmazonOrderHeader,
  formatAmazonItemCaption,
  formatAmazonCancelAlert,
  formatAmazonCancelHeader,
};
