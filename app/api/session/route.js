import { NextResponse } from 'next/server';
import { getDb } from '../../../lib/db';
import { parseCurl } from '../../../lib/curl';
import { isAuthed } from '../../../lib/adminAuth';

export const runtime = 'nodejs';

export async function POST(request) {
  if (!(await isAuthed())) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  const { curl, marketplace } = await request.json();
  if (!curl) {
    return NextResponse.json({ error: 'missing curl text' }, { status: 400 });
  }

  const headers = parseCurl(curl);
  if (!headers.cookie) {
    return NextResponse.json({ error: 'No "cookie" header found — make sure you copied the full request headers.' }, { status: 400 });
  }

  const isAmazon = marketplace === 'amazon';
  const sessionId = isAmazon ? 'session_amazon' : 'session';
  const expiredFlag = isAmazon ? 'amazonSessionExpiredAlertSent' : 'sessionExpiredAlertSent';

  const db = await getDb();
  await db.collection('settings').updateOne(
    { _id: sessionId },
    { $set: { headers, capturedAt: new Date().toISOString() } },
    { upsert: true }
  );
  await db.collection('settings').updateOne(
    { _id: 'status' },
    { $set: { [expiredFlag]: false } },
    { upsert: true }
  );

  return NextResponse.json({ ok: true, headerCount: Object.keys(headers).length });
}
