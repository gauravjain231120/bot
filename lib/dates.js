// Vercel's server clock is UTC — without an explicit timezone, dates render in UTC
// instead of the seller's actual local time (Rangrooh operates out of Rajasthan, India).
function formatIST(ms) {
  if (!ms) return 'unknown';
  return new Date(ms).toLocaleString('en-IN', {
    timeZone: 'Asia/Kolkata',
    dateStyle: 'medium',
    timeStyle: 'short',
  });
}

module.exports = { formatIST };
