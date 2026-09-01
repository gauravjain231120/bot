import { NextResponse } from 'next/server';
import { getDb } from '../../../../lib/db';
import { setRunning } from '../../../../lib/monitorState';
import { isAuthed } from '../../../../lib/adminAuth';
import { runCheckOrders } from '../../../../lib/checkOrders';
import { runCheckAmazonOrders } from '../../../../lib/checkAmazonOrders';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST() {
  if (!(await isAuthed())) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  const db = await getDb();
  await setRunning(db, true);

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
