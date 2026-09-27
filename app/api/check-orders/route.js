import { NextResponse } from 'next/server';
import { getDb } from '../../../lib/db';
import { cronAuthorized, cronFailure } from '../../../lib/cronRoute';
import { recordTick, checkTicks } from '../../../lib/cronWatchdog';
import { getRunning } from '../../../lib/monitorState';
import { runCheckOrders } from '../../../lib/checkOrders';
import { checkStoppedWatchdog } from '../../../lib/watchdog';
import { checkExtensionSyncWatchdog } from '../../../lib/sessionSyncWatchdog';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Called by an external scheduler (cron-job.org, every 2 minutes). Always ticks, but does nothing
// while monitoring is stopped — new orders simply stay unseen until Start is pressed,
// at which point they're picked up as "new" on the next check.
export async function GET(request) {
  if (!cronAuthorized(request)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  const db = await getDb();
  await recordTick(db, 'orders');
  await checkTicks(db, ['amazonOrders', 'cancellations', 'amazonCancellations', 'otc']);
  // The extension syncs on its own 4h timer, independent of whether checking
  // is running or stopped — watch it unconditionally, same as every tick.
  // A watchdog problem must never block the order check itself.
  await checkExtensionSyncWatchdog(db).catch((err) => console.error('extension sync watchdog failed:', err.message));
  if (!(await getRunning(db))) {
    await checkStoppedWatchdog(db).catch((err) => console.error('stopped watchdog failed:', err.message));
    return NextResponse.json({ skipped: true, reason: 'stopped' });
  }

  try {
    const result = await runCheckOrders();
    return NextResponse.json(result);
  } catch (err) {
    return cronFailure(err);
  }
}
