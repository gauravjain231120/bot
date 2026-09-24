import { NextResponse } from 'next/server';
import { isAuthed, getCurrentAccount } from '../../../../lib/adminAuth';
import { amazonReturnTypeFor } from '../../../../lib/returnTypeServer';
import { normalizeOrderId } from '../../../../lib/amazonScan';
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
  // Worked out server-side (Owner-only info — see lib/returnTypeServer.js).
  const account = await getCurrentAccount();
  const isOwner = !!account && account.role === 'OWNER';
  const returnType = await amazonReturnTypeFor(body.trackingId, body.returnType, isOwner);

  const result = await addReturnToStockManager({
    sku: body.sku,
    qty: body.qty,
    trackingId: body.trackingId,
    condition: body.condition,
    returnType,
    allowDuplicate: body.allowDuplicate === true,
    // The Amazon order id, if the page had one — only a real 3-7-7 id is passed on.
    orderId: normalizeOrderId(body.orderId) || undefined,
    channel: 'AMAZON',
  });
  if (!result.ok) {
    // Already logged: 409 so the page can offer "Log it again anyway".
    if (result.duplicate) return NextResponse.json({ error: result.error, duplicate: true }, { status: 409 });
    return NextResponse.json({ error: result.error }, { status: 502 });
  }
  return NextResponse.json({ ok: true });
}
