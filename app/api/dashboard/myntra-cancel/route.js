import { NextResponse } from 'next/server';
import { getDb } from '../../../../lib/db';
import { requireSection } from '../../../../lib/access';
import {
  lookupForCancel,
  markCancelled,
  retryStock,
  undoCancel,
  removeEntry,
  listManualCancels,
} from '../../../../lib/manualCancels';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// A scan reads the parcel and up to 8 orders from Myntra, then stock-manager.
export const maxDuration = 60;

// The Myntra Cancel page (app/myntra-cancel, lib/manualCancels.js).
//   GET                                   the list (database only)
//   POST { action: 'lookup', id }         a scan: the parcel + its order (Myntra, only now)
//   POST { action: 'mark', trackingNumber, orderId? }
//   POST { action: 'retry', trackingNumber }   stock-manager again, same requests
//   POST { action: 'undo', trackingNumber }    marked by mistake
//   DELETE ?id=…                          off the list (after 4 days, stock untouched)

async function myntraHeaders() {
  const db = await getDb();
  const sessionDoc = await db.collection('settings').findOne({ _id: 'session' });
  return sessionDoc && sessionDoc.headers ? sessionDoc.headers : null;
}

function failure(err) {
  const status = err.response && err.response.status;
  if (status === 401 || status === 403) {
    return NextResponse.json({ error: 'Myntra session expired — refresh it on the Sessions page.' }, { status: 401 });
  }
  return NextResponse.json({ error: err.message }, { status: err.status || 500 });
}

export async function GET() {
  const access = await requireSection('myntraCancel');
  if (!access.ok) return NextResponse.json({ error: access.error }, { status: access.status });
  return NextResponse.json({ entries: await listManualCancels() });
}

export async function POST(request) {
  const access = await requireSection('myntraCancel');
  if (!access.ok) return NextResponse.json({ error: access.error }, { status: access.status });
  const body = await request.json().catch(() => ({}));
  const action = String(body.action || '');
  const tracking = String(body.trackingNumber || body.id || '');

  try {
    if (action === 'lookup' || action === 'mark') {
      const headers = await myntraHeaders();
      if (!headers) return NextResponse.json({ error: 'No Myntra session saved — paste one on the Sessions page.' }, { status: 400 });
      if (action === 'lookup') {
        const found = await lookupForCancel(tracking, headers);
        if (found.notFound) {
          return NextResponse.json(
            { error: `No packed shipment found for ${tracking.toUpperCase()}. It may not be packed yet, or the label belongs to another warehouse.` },
            { status: 404 }
          );
        }
        return NextResponse.json(found);
      }
      const orderId = body.orderId ? String(body.orderId).replace(/\D/g, '') : null;
      return NextResponse.json(await markCancelled({ trackingNumber: tracking, orderId, by: access.account.username, headers }));
    }
    if (action === 'retry') return NextResponse.json(await retryStock(tracking));
    if (action === 'undo') {
      const r = await undoCancel(tracking);
      if (r.refused) return NextResponse.json({ error: r.refused }, { status: 409 });
      return NextResponse.json({ ok: true });
    }
    return NextResponse.json({ error: 'Unknown action' }, { status: 400 });
  } catch (err) {
    return failure(err);
  }
}

export async function DELETE(request) {
  const access = await requireSection('myntraCancel');
  if (!access.ok) return NextResponse.json({ error: access.error }, { status: access.status });
  const id = request.nextUrl.searchParams.get('id') || '';
  const r = await removeEntry(id);
  if (r.refused) return NextResponse.json({ error: r.refused }, { status: 409 });
  return NextResponse.json({ ok: true });
}
