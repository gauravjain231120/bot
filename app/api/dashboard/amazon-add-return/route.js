import { NextResponse } from 'next/server';
import { isAuthed } from '../../../../lib/adminAuth';
import { addReturnToStockManager } from '../../../../lib/returns';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** POST { sku, qty, trackingId, condition } -> logs an AMAZON return into
 *  stock-manager (same POST /api/register path as the Myntra Scan Return's
 *  /api/dashboard/add-return, just channel AMAZON). Kept as its own route so
 *  the Myntra one is untouched. */
export async function POST(request) {
  if (!(await isAuthed())) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  const body = await request.json().catch(() => ({}));
  if (!body.sku) {
    return NextResponse.json({ error: 'sku is required' }, { status: 400 });
  }
  const result = await addReturnToStockManager({
    sku: body.sku,
    qty: body.qty,
    trackingId: body.trackingId,
    condition: body.condition,
    returnType: body.returnType,
    channel: 'AMAZON',
  });
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: 502 });
  }
  return NextResponse.json({ ok: true });
}
