const { probeAmazonSession, isSignIn } = require('./amazon');
const { fetchOpenOrders } = require('./myntra');

/**
 * One live call to see whether a session (headers) actually works, before the
 * bot switches to it — shared by the extension sync (/api/session/sync) and
 * the Sessions page's manual paste (/api/session), so neither can replace a
 * working session with a broken one.
 *
 * Returns:
 *   { ok: true }
 *   { rejected: true, detail }     a genuine "not logged in": 401, Myntra's own
 *                                  "session expired" / JSON 403, Amazon's
 *                                  sign-in answer
 *   { unreachable: true, detail }  couldn't tell — network / 5xx / a bot-
 *                                  protection block (Akamai on Myntra, a plain
 *                                  403 on Amazon), which says nothing about
 *                                  the session itself
 */
async function testSession(marketplace, headers) {
  try {
    if (marketplace === 'amazon') await probeAmazonSession(headers);
    else await fetchOpenOrders(headers);
    return { ok: true };
  } catch (err) {
    const status = err.response && err.response.status;
    const rejected =
      status === 401 ||
      err.sessionExpired ||
      (marketplace === 'amazon' && status === 403 && isSignIn(err)) ||
      (marketplace === 'myntra' && status === 403 && !err.blocked);
    const detail = `HTTP ${status || ''} ${err.message}`.trim();
    return rejected ? { rejected: true, detail } : { unreachable: true, detail };
  }
}

module.exports = { testSession };
