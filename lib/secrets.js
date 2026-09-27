const crypto = require('crypto');

// Constant-time secret check (a plain !== leaks, byte by byte, how much of a
// guess was right). Hashing first makes both sides the same length.
function secretMatches(given, expected) {
  if (!expected || typeof given !== 'string' || !given) return false;
  const a = crypto.createHash('sha256').update(given).digest();
  const b = crypto.createHash('sha256').update(String(expected)).digest();
  return crypto.timingSafeEqual(a, b);
}

module.exports = { secretMatches };
