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

// Date-only version, for ship-by dates that are a calendar day, not a specific time.
function formatISTDate(ms) {
  if (!ms) return 'unknown';
  return new Date(ms).toLocaleDateString('en-IN', {
    timeZone: 'Asia/Kolkata',
    dateStyle: 'medium',
  });
}

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

// Myntra's own packByTime isn't a real ship deadline (sometimes only minutes after
// the order). The seller's actual dispatch rule: orders placed before 1pm IST ship
// the same day; orders placed at/after 1pm IST ship the next day. Returns the END
// of that day (23:59:59.999 IST) — the actual deadline instant — not its start, so
// a same-day order isn't treated as "already overdue" the moment any time passes
// midnight.
function myntraShipByDateMs(orderDateMs) {
  if (!orderDateMs) return null;
  const shifted = new Date(orderDateMs + IST_OFFSET_MS);
  const hour = shifted.getUTCHours(); // reads as the IST hour-of-day, since shifted above
  const dayOffset = hour < 13 ? 0 : 1;
  const shipByIstEndOfDay = Date.UTC(
    shifted.getUTCFullYear(),
    shifted.getUTCMonth(),
    shifted.getUTCDate() + dayOffset,
    23, 59, 59, 999
  );
  return shipByIstEndOfDay - IST_OFFSET_MS;
}

module.exports = { formatIST, formatISTDate, myntraShipByDateMs };
