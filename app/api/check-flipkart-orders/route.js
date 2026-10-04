import { NextResponse } from 'next/server';
import { getDb } from '../../../lib/db';
import { cronAuthorized, cronFailure } from '../../../lib/cronRoute';
import { recordTick } from '../../../lib/cronWatchdog';
import { getRunning } from '../../../lib/monitorState';
import { runCheckFlipkartOrders } from '../../../lib/checkFlipkartOrders';
import { checkStoppedWatchdog } from '../../../lib/watchdog';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export async function GET(request) {
  if (!cronAuthorized(request)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  const db = await getDb();
  await recordTick(db, 'flipkartOrders');
  if (!(await getRunning(db))) {
    await checkStoppedWatchdog(db);
    return NextResponse.json({ skipped: true, reason: 'stopped' });
  }

  try {
    const result = await runCheckFlipkartOrders();
    return NextResponse.json(result);
  } catch (err) {
    return cronFailure(err);
  }
}
