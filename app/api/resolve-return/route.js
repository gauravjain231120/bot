import { NextResponse } from 'next/server';
import { getDb } from '../../../lib/db';
import { resolveReturnByTrackingId } from '../../../lib/myntra';
import { secretMatches } from '../../../lib/secrets';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Server-to-server only — called by stock-manager's own backend (never a
// browser directly), the one new direction of communication between these
// two apps (every existing call goes the other way, bot -> stock-manager).
// Shared secret in a header, same convention as EXTENSION_SYNC_SECRET's
// x-sync-secret, not a query param, so it never ends up logged in a URL.
export async function GET(request) {
  const secret = request.headers.get('x-resolve-secret');
  if (!secretMatches(secret, process.env.RESOLVE_RETURN_SECRET)) {
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
    // Always an array — a shipment with more than one product on it returns
    // more than one entry here (confirmed real case), so the caller must
    // never assume just one result.
    const items = await resolveReturnByTrackingId(trackingId, sessionDoc.headers);
    if (!items.length) {
      return NextResponse.json({ error: `No SPF claim found for ${trackingId}` }, { status: 404 });
    }
    const resolvable = items.filter((i) => i.sku);
    if (!resolvable.length) {
      return NextResponse.json(
        { error: `Found ${items.length === 1 ? 'the return' : `${items.length} items`}, but couldn't resolve a SKU for ${items.length === 1 ? 'it' : 'any of them'}.`, partial: items },
        { status: 404 },
      );
    }
    return NextResponse.json({ items: resolvable });
  } catch (err) {
    const status = err.response && err.response.status;
    return NextResponse.json({ error: err.message }, { status: status === 401 || status === 403 ? 401 : 500 });
  }
}
