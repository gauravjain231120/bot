import { NextResponse } from 'next/server';
import { getDb } from '../../../../lib/db';
import { isAuthed } from '../../../../lib/adminAuth';
import { lookupPackedShipment } from '../../../../lib/myntra';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Return labels aren't outbound packets, so searchPostPackedOrder never finds
// them — worth pointing at the right page instead of a bare "not found".
const RETURN_LABEL_PREFIXES = ['MYSR', 'MYER'];

// GET /api/dashboard/packed-lookup?id=<tracking number or packet id> — the
// "Scan packed/picked" page's lookup (app/packed/page.js). Read-only, one
// live Myntra call per scan (see lib/myntra.js's lookupPackedShipment), gated
// by the normal dashboard login like the return resolver next to it.
export async function GET(request) {
  if (!(await isAuthed())) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  const id = (request.nextUrl.searchParams.get('id') || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!id) {
    return NextResponse.json({ error: 'Scan or type a tracking number' }, { status: 400 });
  }

  const db = await getDb();
  const sessionDoc = await db.collection('settings').findOne({ _id: 'session' });
  if (!sessionDoc || !sessionDoc.headers) {
    return NextResponse.json({ error: 'No Myntra session saved — paste one on the admin page.' }, { status: 400 });
  }

  try {
    const packet = await lookupPackedShipment(id, sessionDoc.headers);
    if (!packet) {
      const hint = RETURN_LABEL_PREFIXES.some((p) => id.startsWith(p))
        ? ' This looks like a return label — use Scan Return instead.'
        : ' It may not be packed yet, or the label belongs to another warehouse.';
      return NextResponse.json({ error: `No packed shipment found for ${id}.${hint}` }, { status: 404 });
    }
    return NextResponse.json({ packet });
  } catch (err) {
    const status = err.response && err.response.status;
    if (status === 401 || status === 403) {
      return NextResponse.json({ error: 'Myntra session expired — refresh it on the Sessions page.' }, { status: 401 });
    }
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
