import { NextResponse } from 'next/server';
import { saveSession } from '../../../../lib/sessionStore';
import { getDb } from '../../../../lib/db';

export const runtime = 'nodejs';

/**
 * POST /api/session/sync — the browser-extension equivalent of pasting a
 * session on the admin page. A tiny extension reads the (HttpOnly) Myntra
 * cookies straight from Chrome's cookie jar — something a page script can't
 * do — and posts them here on a timer, so nobody has to open DevTools and
 * copy a curl command by hand every few hours.
 *
 * Auth is a shared secret, not the admin cookie — the extension runs in a
 * different browser context than the dashboard, with no cookie in common.
 */
export async function POST(request) {
  const secret = request.headers.get('x-sync-secret');
  if (!process.env.EXTENSION_SYNC_SECRET || secret !== process.env.EXTENSION_SYNC_SECRET) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  const body = await request.json().catch(() => null);
  if (!body || typeof body.headers !== 'object') {
    return NextResponse.json({ error: 'missing headers' }, { status: 400 });
  }

  const marketplace = body.marketplace === 'amazon' ? 'amazon' : 'myntra';

  try {
    const result = await saveSession({ marketplace, headers: body.headers, source: 'extension' });

    // Accepting the cookies here only proves you're logged into the SITE in
    // this browser, not that the session actually works against the real
    // API — Amazon in particular sets cookies even when logged out, so a
    // stale/expired session would otherwise "sync" successfully every time.
    // The ~1-minute order poller is what actually calls the real API and
    // already records the outcome in `settings.status`; surface THAT as this
    // sync's result instead of a blind "ok", so an expired session shows up
    // as a failure here too, not just as a Telegram alert nobody in the
    // extension popup ever sees.
    const db = await getDb();
    const statusDoc = await db.collection('settings').findOne({ _id: 'status' });
    const lastError = marketplace === 'amazon' ? statusDoc?.amazonLastError : statusDoc?.lastError;
    if (lastError) {
      return NextResponse.json({ error: lastError }, { status: 401 });
    }

    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    return NextResponse.json({ error: err.message }, { status: 400 });
  }
}
