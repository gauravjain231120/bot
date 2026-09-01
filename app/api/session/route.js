import { NextResponse } from 'next/server';
import { getDb } from '../../../lib/db';
import { parseCurl } from '../../../lib/curl';
import { isAuthed } from '../../../lib/adminAuth';

export const runtime = 'nodejs';

export async function POST(request) {
  if (!(await isAuthed())) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  const { curl } = await request.json();
  if (!curl) {
    return NextResponse.json({ error: 'missing curl text' }, { status: 400 });
  }

  const headers = parseCurl(curl);
  if (!headers.cookie) {
    return NextResponse.json({ error: 'No "cookie" header found — make sure you used Copy as cURL.' }, { status: 400 });
  }

  const db = await getDb();
  await db.collection('settings').updateOne(
    { _id: 'session' },
    { $set: { headers, capturedAt: new Date().toISOString() } },
    { upsert: true }
  );
  await db.collection('settings').updateOne(
    { _id: 'status' },
    { $set: { sessionExpiredAlertSent: false } },
    { upsert: true }
  );

  return NextResponse.json({ ok: true, headerCount: Object.keys(headers).length });
}
