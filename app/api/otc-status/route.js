import { NextResponse } from 'next/server';
import { getOtcDisplayStatus, clearOtcDisplay } from '../../../lib/checkOtc';
import { requireSection } from '../../../lib/access';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const access = await requireSection('overview');
  if (!access.ok) return NextResponse.json({ error: access.error }, { status: access.status });
  const status = await getOtcDisplayStatus();
  return NextResponse.json(status);
}

// "Clear" — dashboard-display only. Never touches alertedDate, so it can
// never cause the poller to start calling the Myntra API again today.
export async function PATCH() {
  const access = await requireSection('overview');
  if (!access.ok) return NextResponse.json({ error: access.error }, { status: access.status });
  await clearOtcDisplay();
  const status = await getOtcDisplayStatus();
  return NextResponse.json(status);
}
