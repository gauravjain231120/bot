import { NextResponse } from 'next/server';
import { getDb } from '../../../lib/db';
import { isAuthed } from '../../../lib/adminAuth';
import { fetchPackedPackets } from '../../../lib/myntra';
import { todayIst } from '../../../lib/telegramCommands';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// A busy few days can be several Myntra pages — give it room.
export const maxDuration = 30;

const PACKED_CACHE_MS = 10 * 60 * 1000;
const istDay = (ms) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date(ms));
// Refresh skips the cache, but never re-walks Myntra more than this often.
const FRESH_MIN_GAP_MS = 30 * 1000;

// GET /api/packed-count[?fresh=1] — the dashboard's "Myntra packed" card
// (lib/myntra.js fetchPackedPackets):
//   count        packets waiting for pickup (status PACKED) among those packed
//                in the last 4 days (today + 3 days before)
//   today        packets packed today, picked up yet or not
//   todayPicked  of those, how many the courier already took — so "0 waiting"
//                right after the pickup reads as what it is
//   overdue      waiting packets already past their pick-by time — something
//                to look at on Myntra, shown with its tracking ids
//
// Deliberately NOT part of the dashboard's auto-refresh loop (it's loaded
// once when the page opens, and on Refresh) — this hits Myntra's live API,
// unlike the other dashboard stats which just read already-stored DB state.
// Cached 10 min so page loads and tabs share one lookup; Refresh (fresh=1)
// gets a live count unless one was taken in the last 30 s.
export async function GET(request) {
  if (!(await isAuthed())) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  const db = await getDb();
  const settings = db.collection('settings');
  const sessionDoc = await settings.findOne({ _id: 'session' });
  if (!sessionDoc || !sessionDoc.headers) {
    return NextResponse.json({ error: 'No Myntra session saved — paste one on the admin page.' }, { status: 400 });
  }

  const dayKey = todayIst();
  const fresh = new URL(request.url).searchParams.get('fresh') === '1';
  const cache = await settings.findOne({ _id: 'packed_waiting_cache' });
  const cacheAge = cache ? Date.now() - new Date(cache.at).getTime() : Infinity;
  if (cache && cache.dayKey === dayKey && cacheAge < (fresh ? FRESH_MIN_GAP_MS : PACKED_CACHE_MS)) {
    const { count, today, todayPicked, overdue, overdueIds, capped, days } = cache;
    return NextResponse.json({ count, today, todayPicked, overdue, overdueIds, capped, days, dayKey, cachedAt: cache.at });
  }
  try {
    const { packets, capped, days, startDate } = await fetchPackedPackets(sessionDoc.headers);
    const waiting = packets.filter((p) => p.status === 'PACKED');
    const count = waiting.length;
    const packedToday = packets.filter((p) => p.packedOn && istDay(p.packedOn) === dayKey);
    const today = packedToday.length;
    const todayPicked = packedToday.filter((p) => p.status !== 'PACKED').length;
    const late = waiting.filter((p) => p.pickBy && p.pickBy < Date.now());
    const overdue = late.length;
    const overdueIds = late.map((p) => p.trackingNumber).filter(Boolean).slice(0, 10);
    const at = new Date().toISOString();
    await settings.updateOne(
      { _id: 'packed_waiting_cache' },
      { $set: { dayKey, count, today, todayPicked, overdue, overdueIds, capped, days, since: startDate, at } },
      { upsert: true },
    );
    return NextResponse.json({ count, today, todayPicked, overdue, overdueIds, capped, days, dayKey });
  } catch (err) {
    const status = err.response && err.response.status;
    return NextResponse.json({ error: err.message }, { status: status === 401 || status === 403 ? 401 : 500 });
  }
}
