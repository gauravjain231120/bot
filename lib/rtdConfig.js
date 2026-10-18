const axios = require('axios');
const { getStockDb } = require('./stock');

const DEFAULT_MYNTRA_RTD_CUTOFF = '13:00'; // 1:00 PM IST
const STOCK_MANAGER_URL = process.env.STOCK_MANAGER_URL || 'https://stock-manager-self-nine.vercel.app';

let _cachedHolidays = null;
let _cachedHolidaysAt = 0;
const CACHE_TTL_MS = 60 * 1000;

async function getMyntraRtdCutoff() {
  try {
    if (typeof getStockDb === 'function') {
      const db = await getStockDb();
      const doc = await db.collection('settings').findOne({ _id: 'myntra_rtd' });
      if (doc && typeof doc.value === 'string') return doc.value;
      if (doc && typeof doc.value?.cutoffTime === 'string') return doc.value.cutoffTime;
    }
  } catch (err) {
    // fallback to http below
  }

  try {
    const res = await axios.get(`${STOCK_MANAGER_URL}/api/settings/rtd`, { timeout: 5000 });
    if (res.data && res.data.cutoff) return res.data.cutoff;
  } catch {}

  return DEFAULT_MYNTRA_RTD_CUTOFF;
}

async function getMyntraHolidays() {
  const now = Date.now();
  if (_cachedHolidays && now - _cachedHolidaysAt < CACHE_TTL_MS) {
    return _cachedHolidays;
  }

  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());

  // 1. Try direct MongoDB read
  try {
    if (typeof getStockDb === 'function') {
      const db = await getStockDb();
      const doc = await db.collection('settings').findOne({ _id: 'myntra_holidays' });
      if (doc && Array.isArray(doc.value)) {
        const active = doc.value.filter((d) => typeof d === 'string' && d >= today).sort();
        _cachedHolidays = active;
        _cachedHolidaysAt = now;
        return active;
      }
    }
  } catch (err) {
    console.warn('Direct MongoDB holidays lookup failed, trying HTTP fallback:', err.message);
  }

  // 2. Try HTTP API from stock-manager (public fallback)
  try {
    const res = await axios.get(`${STOCK_MANAGER_URL}/api/settings/holidays`, { timeout: 5000 });
    if (res.data && Array.isArray(res.data.holidays)) {
      const active = res.data.holidays.filter((d) => typeof d === 'string' && d >= today).sort();
      _cachedHolidays = active;
      _cachedHolidaysAt = now;
      return active;
    }
  } catch (httpErr) {
    console.warn('HTTP holidays lookup failed:', httpErr.message);
  }

  return _cachedHolidays || [];
}

module.exports = {
  DEFAULT_MYNTRA_RTD_CUTOFF,
  getMyntraRtdCutoff,
  getMyntraHolidays,
};
