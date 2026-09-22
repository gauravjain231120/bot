import { NextResponse } from 'next/server';
import { isAuthed } from '../../../lib/adminAuth';
import { getOtcDisplayStatus, clearOtcDisplay } from '../../../lib/checkOtc';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  if (!(await isAuthed())) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  const status = await getOtcDisplayStatus();
  return NextResponse.json(status);
}

// "Clear" — dashboard-display only. Never touches alertedDate, so it can
// never cause the poller to start calling the Myntra API again today.
export async function PATCH() {
  if (!(await isAuthed())) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  await clearOtcDisplay();
  const status = await getOtcDisplayStatus();
  return NextResponse.json(status);
}
