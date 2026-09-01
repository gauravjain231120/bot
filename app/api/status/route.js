import { NextResponse } from 'next/server';
import { getDb } from '../../../lib/db';
import { isAuthed } from '../../../lib/adminAuth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  if (!(await isAuthed())) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  const db = await getDb();
  const [sessionDoc, amazonSessionDoc, statusDoc] = await Promise.all([
    db.collection('settings').findOne({ _id: 'session' }),
    db.collection('settings').findOne({ _id: 'session_amazon' }),
    db.collection('settings').findOne({ _id: 'status' }),
  ]);

  return NextResponse.json({
    running: Boolean(statusDoc && statusDoc.running),
    lastCheck: statusDoc?.lastCheck ?? null,
    openCount: statusDoc?.openCount ?? null,
    lastError: statusDoc?.lastError ?? null,
    lastCancelCheck: statusDoc?.lastCancelCheck ?? null,
    cancelledCount: statusDoc?.cancelledCount ?? null,
    lastCancelError: statusDoc?.lastCancelError ?? null,
    sessionCapturedAt: sessionDoc?.capturedAt ?? null,
    amazonLastCheck: statusDoc?.amazonLastCheck ?? null,
    amazonOpenCount: statusDoc?.amazonOpenCount ?? null,
    amazonLastError: statusDoc?.amazonLastError ?? null,
    amazonSessionCapturedAt: amazonSessionDoc?.capturedAt ?? null,
  });
}
