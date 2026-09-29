import { NextResponse } from 'next/server';
import { getDb } from '../../../lib/db';
import { cronAuthorized, cronFailure } from '../../../lib/cronRoute';
import { recordTick } from '../../../lib/cronWatchdog';
import { getRunning } from '../../../lib/monitorState';
import { runCheckAmazonOrders } from '../../../lib/checkAmazonOrders';
import { checkStoppedWatchdog } from '../../../lib/watchdog';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

// Called by an external scheduler (cron-job.org, every 5 minutes), like /api/check-orders.
export async function GET(request) {
  if (!cronAuthorized(request)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  const db = await getDb();
  await recordTick(db, 'amazonOrders');
  if (!(await getRunning(db))) {
    await checkStoppedWatchdog(db);
    return NextResponse.json({ skipped: true, reason: 'stopped' });
  }

  try {
    const result = await runCheckAmazonOrders();
    return NextResponse.json(result);
  } catch (err) {
    return cronFailure(err);
  }
}
