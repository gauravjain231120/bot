import { NextResponse } from 'next/server';
import { getDb } from '../../../lib/db';
import { cronAuthorized, cronFailure } from '../../../lib/cronRoute';
import { recordTick, checkTicks } from '../../../lib/cronWatchdog';
import { getRunning } from '../../../lib/monitorState';
import { runCheckOtc } from '../../../lib/checkOtc';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Called by an external scheduler (cron-job.org, every 2 minutes — keep it
// running ALL DAY, since the check window is changeable on the dashboard).
// Always ticks, but runCheckOtc() itself is a no-op (one DB read, no Myntra
// call) outside the dashboard-set IST window (default 12:00–13:00) or once already
// alerted for the day, so it's harmless to hit more often or outside that
// window — nothing extra to configure on the scheduler side for correctness,
// only for not wasting calls.
export async function GET(request) {
  if (!cronAuthorized(request)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  const db = await getDb();
  await recordTick(db, 'otc');
  await checkTicks(db, ['orders']);
  if (!(await getRunning(db))) {
    return NextResponse.json({ skipped: true, reason: 'stopped' });
  }

  try {
    const result = await runCheckOtc();
    return NextResponse.json(result);
  } catch (err) {
    return cronFailure(err);
  }
}
