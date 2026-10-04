const { probeFlipkartSession, isFlipkartSessionExpired } = require('./flipkart');

async function testFlipkartSession(headers) {
  try {
    await probeFlipkartSession(headers);
    return { ok: true };
  } catch (err) {
    const status = err.response && err.response.status;
    const rejected = status === 401 || err.sessionExpired || status === 403;
    const detail = `HTTP ${status || ''} ${err.message}`.trim();
    return rejected ? { rejected: true, detail } : { unreachable: true, detail };
  }
}

module.exports = { testFlipkartSession };
