import { NextResponse } from 'next/server';
import { saveSession } from '../../../../lib/sessionStore';

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

  try {
    const result = await saveSession({
      marketplace: body.marketplace === 'amazon' ? 'amazon' : 'myntra',
      headers: body.headers,
      source: 'extension',
    });
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    return NextResponse.json({ error: err.message }, { status: 400 });
  }
}
