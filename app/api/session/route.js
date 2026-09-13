import { NextResponse } from 'next/server';
import { parseCurl } from '../../../lib/curl';
import { isAuthed } from '../../../lib/adminAuth';
import { saveSession } from '../../../lib/sessionStore';

export const runtime = 'nodejs';

export async function POST(request) {
  if (!(await isAuthed())) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  const { curl, marketplace } = await request.json();
  if (!curl) {
    return NextResponse.json({ error: 'missing curl text' }, { status: 400 });
  }

  const headers = parseCurl(curl);
  if (!headers.cookie) {
    return NextResponse.json(
      {
        error:
          'No "cookie" header found. This usually means the request came from Chrome\'s cache ' +
          '("Provisional headers are shown" in DevTools never includes cookies). Fix: in Network tab, ' +
          'check "Disable cache", then hard-refresh (Cmd+Shift+R) BEFORE copying — this forces a real ' +
          'network request with the real headers instead of a cached one.',
      },
      { status: 400 }
    );
  }

  const result = await saveSession({ marketplace, headers, source: 'manual' });
  return NextResponse.json({ ok: true, ...result });
}
