import { NextResponse } from 'next/server';
import { getDb } from '../../../lib/db';
import { getRunning } from '../../../lib/monitorState';
import { runCheckOrders } from '../../../lib/checkOrders';
import { checkStoppedWatchdog } from '../../../lib/watchdog';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Called by an external scheduler every ~1 minute. Always ticks, but does nothing
// while monitoring is stopped — new orders simply stay unseen until Start is pressed,
// at which point they're picked up as "new" on the next check.
export async function GET(request) {
  const secret = request.nextUrl.searchParams.get('secret');
  if (!process.env.CRON_SECRET || secret !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  const db = await getDb();
  if (!(await getRunning(db))) {
    await checkStoppedWatchdog(db);
    return NextResponse.json({ skipped: true, reason: 'stopped' });
  }

  try {
    const result = await runCheckOrders();
    return NextResponse.json(result);
  } catch (err) {
    const status = err.status === 401 || err.status === 403 ? 401 : 500;
    return NextResponse.json({ error: err.message }, { status });
  }
}
