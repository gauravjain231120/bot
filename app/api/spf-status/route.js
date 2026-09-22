import { NextResponse } from 'next/server';
import { getDb } from '../../../lib/db';
import { requireOwner } from '../../../lib/adminAuth';
import { fetchSpfTicketCounts } from '../../../lib/myntra';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Owner-only, on-demand — never called from the cron checks or the main
// dashboard's poll loop, only from app/spf-status/page.js when someone
// actually opens it (paginating every SPF ticket is a heavier live Myntra
// call than the other dashboard stats).
export async function GET() {
  const check = await requireOwner();
  if (!check.ok) return NextResponse.json({ error: check.error }, { status: check.status });

  const db = await getDb();
  const sessionDoc = await db.collection('settings').findOne({ _id: 'session' });
  if (!sessionDoc || !sessionDoc.headers) {
    return NextResponse.json({ error: 'No Myntra session saved — paste one on the admin page.' }, { status: 400 });
  }

  try {
    const counts = await fetchSpfTicketCounts(sessionDoc.headers);
    return NextResponse.json(counts);
  } catch (err) {
    const status = err.response && err.response.status;
    return NextResponse.json({ error: err.message }, { status: status === 401 || status === 403 ? 401 : 500 });
  }
}
