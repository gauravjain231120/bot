import { NextResponse } from 'next/server';
import { runCheckOrders } from '../../../../lib/checkOrders';
import { runCheckAmazonOrders } from '../../../../lib/checkAmazonOrders';
import { requireSection } from '../../../../lib/access';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST() {
  const access = await requireSection('controls');
  if (!access.ok) return NextResponse.json({ error: access.error }, { status: access.status });

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
