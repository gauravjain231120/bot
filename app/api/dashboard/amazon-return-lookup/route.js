import { NextResponse } from 'next/server';
import { getDb } from '../../../../lib/db';
import { isAuthed } from '../../../../lib/adminAuth';
import { lookupAmazonReturn } from '../../../../lib/amazonScan';
import { lookupProductBySku } from '../../../../lib/stock';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// GET /api/dashboard/amazon-return-lookup?mode=tracking|order&id=... — the
// "Amazon Return" page's lookup (app/amazon-returns/page.js). Each returned
// item is matched against stock-manager's catalog (read-only, same as the
// Myntra Scan Return resolver) so the page can offer "Add to Return".
export async function GET(request) {
  if (!(await isAuthed())) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  const mode = request.nextUrl.searchParams.get('mode') === 'order' ? 'order' : 'tracking';
  const id = request.nextUrl.searchParams.get('id') || '';

  const db = await getDb();
  const sessionDoc = await db.collection('settings').findOne({ _id: 'session_amazon' });
  if (!sessionDoc || !sessionDoc.headers) {
    return NextResponse.json({ error: 'No Amazon session saved — paste one on the Sessions page.' }, { status: 400 });
  }

  try {
    const result = await lookupAmazonReturn(mode, id, sessionDoc.headers);
    if (result.error) return NextResponse.json({ error: result.error }, { status: result.status || 400 });
    for (const rr of result.returns) {
      for (const item of rr.items) {
        const match = item.sku ? await lookupProductBySku(item.sku) : null;
        item.matchedSku = match ? match.sku : null;
        item.catalogName = match ? match.name : null;
        item.matchError = item.sku ? (match ? null : `SKU ${item.sku} isn't in the product catalog.`) : 'No SKU on this return item.';
      }
    }
    return NextResponse.json(result);
  } catch (err) {
    return NextResponse.json({ error: err.message }, { status: err.sessionExpired ? 401 : 500 });
  }
}
