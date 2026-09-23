import { NextResponse } from 'next/server';
import { getDb } from '../../../../lib/db';
import { isAuthed, getCurrentAccount } from '../../../../lib/adminAuth';
import { resolveReturnByTrackingId } from '../../../../lib/myntra';
import { lookupProductBySku } from '../../../../lib/stock';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// The dashboard's own version of /api/resolve-return — same underlying
// resolver, but gated by the normal admin_auth login (not the
// x-resolve-secret meant for stock-manager's server-to-server call), and
// additionally matches each item against stock-manager's own product
// catalog (via the same read-only STOCK_MONGODB_URI this app already uses
// for stock lookups) so the dashboard can offer "Add to Return" directly,
// without stock-manager's Returns page in the loop at all.
export async function GET(request) {
  if (!(await isAuthed())) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  const trackingId = (request.nextUrl.searchParams.get('trackingId') || '').trim().toUpperCase();
  if (!trackingId) {
    return NextResponse.json({ error: 'trackingId is required' }, { status: 400 });
  }

  const db = await getDb();
  const sessionDoc = await db.collection('settings').findOne({ _id: 'session' });
  if (!sessionDoc || !sessionDoc.headers) {
    return NextResponse.json({ error: 'No Myntra session saved — paste one on the admin page.' }, { status: 400 });
  }

  try {
    const items = await resolveReturnByTrackingId(trackingId, sessionDoc.headers);
    if (!items.length) {
      return NextResponse.json({ error: `No SPF claim found for ${trackingId}` }, { status: 404 });
    }

    const candidates = await Promise.all(
      items.map(async (item) => {
        const match = item.sku ? await lookupProductBySku(item.sku) : null;
        return {
          resolvedSku: item.sku,
          matchedSku: match ? match.sku : null,
          productName: match ? match.name : null,
          image: item.image,
          returnReason: item.returnReason,
          returnMode: item.returnMode,
          returnCreatedDate: item.returnCreatedDate,
          returnType: item.returnType || 'UNKNOWN',
          orderId: item.orderId || null,
          size: item.size,
          color: item.color,
          matchError: item.sku ? (match ? null : `SKU ${item.sku} isn't in the product catalog.`) : 'Could not resolve a SKU for this item.',
        };
      }),
    );

    // Customer return vs RTO is Owner-only.
    const account = await getCurrentAccount();
    if (!account || account.role !== 'OWNER') for (const c of candidates) delete c.returnType;
    return NextResponse.json({ candidates });
  } catch (err) {
    const status = err.response && err.response.status;
    return NextResponse.json({ error: err.message }, { status: status === 401 || status === 403 ? 401 : 500 });
  }
}
