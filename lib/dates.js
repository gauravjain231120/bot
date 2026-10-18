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

function skipHolidays(dayStr, holidays) {
  if (!Array.isArray(holidays) || !holidays.length) return dayStr;
  const set = new Set(holidays);
  let [y, m, d] = dayStr.split("-").map(Number);
  for (let i = 0; i < 60 && set.has(`${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`); i++) {
    const dt = new Date(Date.UTC(y, m - 1, d + 1));
    y = dt.getUTCFullYear();
    m = dt.getUTCMonth() + 1;
    d = dt.getUTCDate();
  }
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

// Myntra's own packByTime isn't a real ship deadline (sometimes only minutes after
// the order). The seller's dispatch rule: orders placed before the RTD cutoff (by default
// 1:00 PM / 13:00 IST) ship the same day; orders placed at/after cutoff ship the next day.
// Any date falling on a configured holiday skips forward to the next working day.
// Returns the END of that day (23:59:59.999 IST) — the actual deadline instant — not its start,
// so a same-day order isn't treated as "already overdue" the moment any time passes midnight.
function myntraShipByDateMs(orderDateMs, cutoffTime = "13:00", holidays = []) {
  if (!orderDateMs) return null;
  const shifted = new Date(orderDateMs + IST_OFFSET_MS);
  const hour = shifted.getUTCHours(); // reads as the IST hour-of-day, since shifted above
  const minute = shifted.getUTCMinutes();
  const [cutoffH, cutoffM] = (cutoffTime || "13:00").split(":").map(Number);
  const orderMins = hour * 60 + minute;
  const cutoffMins = (cutoffH ?? 13) * 60 + (cutoffM || 0);
  const dayOffset = orderMins < cutoffMins ? 0 : 1;

  const rawDate = new Date(Date.UTC(
    shifted.getUTCFullYear(),
    shifted.getUTCMonth(),
    shifted.getUTCDate() + dayOffset,
  ));
  const rawKey = `${rawDate.getUTCFullYear()}-${String(rawDate.getUTCMonth() + 1).padStart(2, "0")}-${String(rawDate.getUTCDate()).padStart(2, "0")}`;

  const finalKey = skipHolidays(rawKey, holidays);
  const [fy, fm, fd] = finalKey.split("-").map(Number);

  const shipByIstEndOfDay = Date.UTC(
    fy,
    fm - 1,
    fd,
    23, 59, 59, 999
  );
  return shipByIstEndOfDay - IST_OFFSET_MS;
}

function isSameDayIST(ms1, ms2) {
  if (!ms1 || !ms2) return false;
  const d1 = new Date(ms1).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
  const d2 = new Date(ms2).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
  return d1 === d2;
}

module.exports = { formatIST, formatISTDate, myntraShipByDateMs, isSameDayIST, skipHolidays };
