// Headers that came from the browser's own transport/compression choices — replaying
// them verbatim from a serverless function causes mismatches, so let axios pick its own.
const DROP_HEADERS = new Set(['content-length', 'accept-encoding', 'connection']);

function parseCurlStyle(curlText) {
  const headers = {};
  const headerRe = /-H\s+\$?'((?:[^'\\]|\\.)*)'/g;
  let m;
  while ((m = headerRe.exec(curlText))) {
    const raw = m[1].replace(/\\'/g, "'");
    const idx = raw.indexOf(':');
    if (idx === -1) continue;
    const name = raw.slice(0, idx).trim().toLowerCase();
    const value = raw.slice(idx + 1).trim();
    if (name.startsWith(':') || DROP_HEADERS.has(name)) continue;
    headers[name] = value;
  }

  // Chrome's "Copy as cURL" puts the cookie in a separate -b/--cookie flag,
  // not as an -H 'cookie: ...' header — handle that form too.
  const cookieRe = /(?:-b|--cookie)\s+\$?'((?:[^'\\]|\\.)*)'/;
  const cookieMatch = cookieRe.exec(curlText);
  if (cookieMatch) {
    headers.cookie = cookieMatch[1].replace(/\\'/g, "'");
  }

  return headers;
}

// Handles pasting the DevTools Headers panel directly (header name on one line,
// its value on the next) — what you get from selecting and copying the panel
// instead of using "Copy as cURL".
function parseHeaderDump(text) {
  const lines = text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  const startIdx = lines.findIndex((l) => l === ':authority' || l === ':method');
  const relevant = startIdx === -1 ? lines : lines.slice(startIdx);
  const headers = {};
  for (let i = 0; i < relevant.length - 1; i += 2) {
    const name = relevant[i].toLowerCase();
    if (!/^[a-z0-9:-]+$/.test(name)) break;
    if (name.startsWith(':') || DROP_HEADERS.has(name)) continue;
    headers[name] = relevant[i + 1];
  }
  return headers;
}

function parseCurl(text) {
  const curlHeaders = parseCurlStyle(text);
  if (curlHeaders.cookie) return curlHeaders;

  const dumpHeaders = parseHeaderDump(text);
  if (dumpHeaders.cookie) return dumpHeaders;

  return curlHeaders;
}

module.exports = { parseCurl };
