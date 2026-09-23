import { NextResponse } from 'next/server';
import { isAuthed, getCurrentAccount } from '../../../../lib/adminAuth';
import { myntraReturnTypeFor } from '../../../../lib/returnTypeServer';
import { addReturnToStockManager } from '../../../../lib/returns';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** POST { sku, qty, trackingId, condition } -> logs a Myntra return directly
 *  into stock-manager, from this dashboard, without needing to open
 *  stock-manager's own Returns page at all. */
export async function POST(request) {
  if (!(await isAuthed())) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  const body = await request.json().catch(() => ({}));
  if (!body.sku) {
    return NextResponse.json({ error: 'sku is required' }, { status: 400 });
  }

  // Worked out server-side (Owner-only info — see lib/returnTypeServer.js).
  const account = await getCurrentAccount();
  const isOwner = !!account && account.role === 'OWNER';
  const returnType = await myntraReturnTypeFor(body.trackingId, body.sku, body.returnType, isOwner);

  const result = await addReturnToStockManager({
    sku: body.sku,
    qty: body.qty,
    trackingId: body.trackingId,
    condition: body.condition,
    returnType,
  });
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: 502 });
  }
  return NextResponse.json({ ok: true });
}
