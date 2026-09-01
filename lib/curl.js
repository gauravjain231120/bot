// Headers that came from the browser's own transport/compression choices — replaying
// them verbatim from a serverless function causes mismatches, so let axios pick its own.
const DROP_HEADERS = new Set(['content-length', 'accept-encoding', 'connection']);

function parseCurl(curlText) {
  const headers = {};
  const re = /-H\s+\$?'((?:[^'\\]|\\.)*)'/g;
  let m;
  while ((m = re.exec(curlText))) {
    const raw = m[1].replace(/\\'/g, "'");
    const idx = raw.indexOf(':');
    if (idx === -1) continue;
    const name = raw.slice(0, idx).trim().toLowerCase();
    const value = raw.slice(idx + 1).trim();
    if (name.startsWith(':') || DROP_HEADERS.has(name)) continue;
    headers[name] = value;
  }
  return headers;
}

module.exports = { parseCurl };
