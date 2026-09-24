import { NextResponse } from 'next/server';
import { getDb } from '../../../lib/db';
import { requireOwner } from '../../../lib/adminAuth';
import { fetchSpfTicketCounts } from '../../../lib/myntra';
import { loadSpfTickets } from '../../../lib/spfCache';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Owner-only, on-demand — never called from the cron checks or the main
// dashboard's poll loop, only from app/spf-status/page.js when someone
// actually opens it (paginating every SPF ticket is a heavier live Myntra
// call than the other dashboard stats). The ticket list is cached 15 min
// (lib/spfCache.js); ?fresh=1 (the page's Refresh button) re-fetches it.
export async function GET(request) {
  const check = await requireOwner();
  if (!check.ok) return NextResponse.json({ error: check.error }, { status: check.status });

  const db = await getDb();
  const sessionDoc = await db.collection('settings').findOne({ _id: 'session' });
  if (!sessionDoc || !sessionDoc.headers) {
    return NextResponse.json({ error: 'No Myntra session saved — paste one on the admin page.' }, { status: 400 });
  }

  try {
    const fresh = new URL(request.url).searchParams.get('fresh') === '1';
    const { tickets, at, cached } = await loadSpfTickets(sessionDoc.headers, { fresh });
    const counts = await fetchSpfTicketCounts(sessionDoc.headers, tickets);
    return NextResponse.json({ ...counts, fetchedAt: at, cached });
  } catch (err) {
    const status = err.response && err.response.status;
    return NextResponse.json({ error: err.message }, { status: status === 401 || status === 403 ? 401 : 500 });
  }
}
