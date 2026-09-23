import { NextResponse } from 'next/server';
import { getDb } from '../../../../lib/db';
import { isAuthed } from '../../../../lib/adminAuth';
import { lookupAmazonPacked } from '../../../../lib/amazonScan';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// GET /api/dashboard/amazon-packed-lookup?mode=tracking|order&id=... — the
// "Amazon Pack" page's lookup (app/amazon-packed/page.js). Read-only, uses the
// saved Amazon session like the order alerts do. See lib/amazonScan.js.
export async function GET(request) {
  if (!(await isAuthed())) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  const mode = request.nextUrl.searchParams.get('mode') === 'order' ? 'order' : 'tracking';
  const id = request.nextUrl.searchParams.get('id') || '';

  const db = await getDb();
  const sessionDoc = await db.collection('settings').findOne({ _id: 'session_amazon' });
  if (!sessionDoc || !sessionDoc.headers) {
    return NextResponse.json({ error: 'No Amazon session saved — paste one on the Sessions page.' }, { status: 400 });
  }

  try {
    const result = await lookupAmazonPacked(mode, id, sessionDoc.headers);
    if (result.error) return NextResponse.json({ error: result.error }, { status: result.status || 400 });
    return NextResponse.json(result);
  } catch (err) {
    return NextResponse.json({ error: err.message }, { status: err.sessionExpired ? 401 : 500 });
  }
}
