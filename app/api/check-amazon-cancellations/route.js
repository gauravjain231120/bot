import { NextResponse } from 'next/server';
import { getDb } from '../../../lib/db';
import { cronAuthorized, cronFailure } from '../../../lib/cronRoute';
import { recordTick } from '../../../lib/cronWatchdog';
import { getRunning } from '../../../lib/monitorState';
import { runCheckAmazonCancellations } from '../../../lib/checkAmazonCancellations';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Called by an external scheduler every ~30 minutes, same cadence as
// /api/check-cancellations (Myntra's equivalent).
export async function GET(request) {
  if (!cronAuthorized(request)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  const db = await getDb();
  await recordTick(db, 'amazonCancellations');
  if (!(await getRunning(db))) {
    return NextResponse.json({ skipped: true, reason: 'stopped' });
  }

  try {
    const result = await runCheckAmazonCancellations();
    return NextResponse.json(result);
  } catch (err) {
    return cronFailure(err);
  }
}
