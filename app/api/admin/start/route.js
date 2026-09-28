import { NextResponse } from 'next/server';
import { getDb } from '../../../../lib/db';
import { setRunning } from '../../../../lib/monitorState';
import { runCheckOrders } from '../../../../lib/checkOrders';
import { runCheckAmazonOrders } from '../../../../lib/checkAmazonOrders';
import { requireSection } from '../../../../lib/access';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST() {
  const access = await requireSection('controls');
  if (!access.ok) return NextResponse.json({ error: access.error }, { status: access.status });

  const db = await getDb();
  await setRunning(db, true);
  // Clear the "stopped too long" watchdog's clock so it starts fresh next
  // time this stops, instead of comparing against a stale stoppedAt.
  await db.collection('settings').updateOne(
    { _id: 'status' },
    { $unset: { stoppedAt: '', stoppedAlertSent: '' } }
  );

  // Run immediate checks instead of waiting for the next scheduled tick, so
  // Start feels instant and catches up on anything that arrived while stopped.
  let checkResult = null;
  let checkError = null;
  try {
    checkResult = await runCheckOrders();
  } catch (err) {
    checkError = err.message;
  }

  let amazonCheckResult = null;
  let amazonCheckError = null;
  try {
    amazonCheckResult = await runCheckAmazonOrders();
  } catch (err) {
    amazonCheckError = err.message;
  }

  return NextResponse.json({ running: true, checkResult, checkError, amazonCheckResult, amazonCheckError });
}
