import { NextResponse } from 'next/server';
import { runCheckOrders } from '../../../../lib/checkOrders';
import { runCheckAmazonOrders } from '../../../../lib/checkAmazonOrders';
import { isAuthed } from '../../../../lib/adminAuth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST() {
  if (!(await isAuthed())) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  let result = null;
  let error = null;
  try {
    result = await runCheckOrders();
  } catch (err) {
    error = err.message;
  }

  let amazonResult = null;
  let amazonError = null;
  try {
    amazonResult = await runCheckAmazonOrders();
  } catch (err) {
    amazonError = err.message;
  }

  if (error && amazonError) {
    return NextResponse.json({ error, amazonError }, { status: 500 });
  }

  return NextResponse.json({ result, error, amazonResult, amazonError });
}
