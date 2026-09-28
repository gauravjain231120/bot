import { NextResponse } from 'next/server';
import { getDb } from '../../../lib/db';
import { cronAuthorized, cronFailure } from '../../../lib/cronRoute';
import { recordTick, checkTicks } from '../../../lib/cronWatchdog';
import { getRunning } from '../../../lib/monitorState';
import { runCheckOtc } from '../../../lib/checkOtc';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Called by an external scheduler (cron-job.org, every 2 minutes). Since
// 2026-09-28 it runs only around the check window (the job's hours match the
// dashboard's OTC window, default 12:00–13:00 IST — change both together);
// the watchdog expects its ticks only inside that window (lib/cronWatchdog.js).
// Called outside it anyway, runCheckOtc() is a no-op (one DB read, no Myntra
// call), as it is once already alerted for the day.
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
