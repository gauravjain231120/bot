import { NextResponse } from 'next/server';
import { getDb } from '../../../lib/db';
import { resolveReturnByTrackingId } from '../../../lib/myntra';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Server-to-server only — called by stock-manager's own backend (never a
// browser directly), the one new direction of communication between these
// two apps (every existing call goes the other way, bot -> stock-manager).
// Shared secret in a header, same convention as EXTENSION_SYNC_SECRET's
// x-sync-secret, not a query param, so it never ends up logged in a URL.
export async function GET(request) {
  const secret = request.headers.get('x-resolve-secret');
  if (!process.env.RESOLVE_RETURN_SECRET || secret !== process.env.RESOLVE_RETURN_SECRET) {
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
    const result = await resolveReturnByTrackingId(trackingId, sessionDoc.headers);
    if (!result) {
      return NextResponse.json({ error: `No SPF claim found for ${trackingId}` }, { status: 404 });
    }
    if (!result.sku) {
      return NextResponse.json(
        { error: `Found the return, but couldn't resolve a SKU for it (original tracking id: ${result.originalTrackingId || 'unknown'}).`, partial: result },
        { status: 404 },
      );
    }
    return NextResponse.json(result);
  } catch (err) {
    const status = err.response && err.response.status;
    return NextResponse.json({ error: err.message }, { status: status === 401 || status === 403 ? 401 : 500 });
  }
}
