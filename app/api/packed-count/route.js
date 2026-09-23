import { NextResponse } from 'next/server';
import { getDb } from '../../../lib/db';
import { isAuthed } from '../../../lib/adminAuth';
import { fetchPackedCount } from '../../../lib/myntra';
import { toDMY, todayIst } from '../../../lib/telegramCommands';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const PACKED_CACHE_MS = 10 * 60 * 1000;

// Deliberately NOT part of the dashboard's 20s auto-refresh loop (app/page.js
// only calls this once, on load) — this hits Myntra's live API every time,
// unlike the other dashboard stats which just read already-stored DB state.
// Polling this in the background would mean calling Myntra every 20s purely
// because the tab is open, whether or not anyone's looking — exactly what
// was asked not to happen.
export async function GET() {
  if (!(await isAuthed())) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  const db = await getDb();
  const sessionDoc = await db.collection('settings').findOne({ _id: 'session' });
  if (!sessionDoc || !sessionDoc.headers) {
    return NextResponse.json({ error: 'No Myntra session saved — paste one on the admin page.' }, { status: 400 });
  }

  const dayKey = todayIst();
  const dmy = toDMY(dayKey);
  // Cached for a few minutes: every dashboard tab/page load asks for this,
  // and each ask was a live Myntra call. Same day + fresh enough = reuse.
  const cache = await db.collection('settings').findOne({ _id: 'packed_count_cache' });
  if (cache && cache.dayKey === dayKey && Date.now() - new Date(cache.at).getTime() < PACKED_CACHE_MS) {
    return NextResponse.json({ count: cache.count, dayKey, cachedAt: cache.at });
  }
  try {
    const count = await fetchPackedCount(dmy, dmy, sessionDoc.headers);
    await db.collection('settings').updateOne(
      { _id: 'packed_count_cache' },
      { $set: { dayKey, count, at: new Date().toISOString() } },
      { upsert: true },
    );
    return NextResponse.json({ count, dayKey });
  } catch (err) {
    const status = err.response && err.response.status;
    return NextResponse.json({ error: err.message }, { status: status === 401 || status === 403 ? 401 : 500 });
  }
}
