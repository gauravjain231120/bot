import { NextResponse } from 'next/server';
import { getDb } from '../../../lib/db';
import { cronAuthorized, cronFailure } from '../../../lib/cronRoute';
import { recordTick, checkTicks } from '../../../lib/cronWatchdog';
import { getRunning } from '../../../lib/monitorState';
import { runCheckCancellations } from '../../../lib/checkCancellations';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Called by an external scheduler every ~5 minutes.
export async function GET(request) {
  if (!cronAuthorized(request)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  const db = await getDb();
  await recordTick(db, 'cancellations');
  await checkTicks(db, ['orders']);
  if (!(await getRunning(db))) {
    return NextResponse.json({ skipped: true, reason: 'stopped' });
  }

  try {
    const result = await runCheckCancellations();
    return NextResponse.json(result);
  } catch (err) {
    return cronFailure(err);
  }
}
