import { NextResponse } from 'next/server';
import { getDb } from '../../../lib/db';
import { getRunning } from '../../../lib/monitorState';
import { runCheckOtc } from '../../../lib/checkOtc';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Called by an external scheduler (cron-job.org, every 2 minutes). Always ticks, but
// runCheckOtc() itself is a no-op outside 12:00–13:00 IST or once already
// alerted for the day, so it's harmless to hit more often or outside that
// window — nothing extra to configure on the scheduler side for correctness,
// only for not wasting calls.
export async function GET(request) {
  const secret = request.nextUrl.searchParams.get('secret');
  if (!process.env.CRON_SECRET || secret !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  const db = await getDb();
  if (!(await getRunning(db))) {
    return NextResponse.json({ skipped: true, reason: 'stopped' });
  }

  try {
    const result = await runCheckOtc();
    return NextResponse.json(result);
  } catch (err) {
    const status = err.status === 401 || err.status === 403 ? 401 : 500;
    return NextResponse.json({ error: err.message }, { status });
  }
}
