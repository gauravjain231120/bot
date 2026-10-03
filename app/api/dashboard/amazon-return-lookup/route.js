import { NextResponse } from 'next/server';
import { getDb } from '../../../../lib/db';
import { getCurrentAccount } from '../../../../lib/adminAuth';
import { lookupAmazonReturn } from '../../../../lib/amazonScan';
import { lookupProductBySku } from '../../../../lib/stock';
import { rememberReturnLookup } from '../../../../lib/returnLookupCache';
import { requireSection } from '../../../../lib/access';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// GET /api/dashboard/amazon-return-lookup?mode=tracking|order&id=... — the
// "Amazon Return" page's lookup (app/amazon-returns/page.js). Each returned
// item is matched against stock-manager's catalog (read-only, same as the
// Myntra Scan Return resolver) so the page can offer "Add to Return".
export async function GET(request) {
  const access = await requireSection('amazonReturn');
  if (!access.ok) return NextResponse.json({ error: access.error }, { status: access.status });
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
        // "Couldn't check" (stock-manager unreachable) is NOT "not in the
        // catalog" — see lookupProductBySku.
        let match = null;
        let catalogError = null;
        if (item.sku) {
          try {
            match = await lookupProductBySku(item.sku);
          } catch (err) {
            catalogError = err.message;
          }
        }
        item.matchedSku = match ? match.sku : null;
        item.catalogName = match ? match.name : null;
        item.matchError = !item.sku
          ? 'No SKU on this return item.'
          : catalogError || (match ? null : `SKU ${item.sku} isn't in the product catalog.`);
      }
    }
    // "Add to Return" reuses this answer (keyed by the tracking id the add
    // will send) instead of calling Amazon again.
    for (const rr of result.returns) {
      const ids = [rr.trackingId, result.searched && mode === 'tracking' ? result.searched : null];
      await rememberReturnLookup('amazon', ids, [{ returnType: rr.returnType || 'UNKNOWN' }]);
    }

    return NextResponse.json(result);
  } catch (err) {
    return NextResponse.json({ error: err.message }, { status: err.sessionExpired ? 401 : 500 });
  }
}
