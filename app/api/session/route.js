import { NextResponse } from 'next/server';
import { parseCurl } from '../../../lib/curl';
import { requireOwner } from '../../../lib/adminAuth';
import { saveSession } from '../../../lib/sessionStore';
import { testSession } from '../../../lib/sessionProbe';

export const runtime = 'nodejs';
// Testing an Amazon session can take ~10s (its 403s are retried).
export const maxDuration = 30;

export async function POST(request) {
  // Owner only: a pasted session decides which seller account every order
  // alert and stock reservation comes from.
  const check = await requireOwner();
  if (!check.ok) return NextResponse.json({ error: check.error }, { status: check.status });

  const { curl, marketplace: rawMarketplace } = await request.json().catch(() => ({}));
  const marketplace = rawMarketplace === 'amazon' ? 'amazon' : 'myntra';
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

  // Tested before it replaces the working session — a stale or logged-out
  // paste used to be saved as-is and silently stop every alert until the
  // extension happened to recover it. A genuine rejection is refused; if the
  // marketplace simply couldn't be reached, the paste is saved (a person
  // deliberately pasted it) with a note that it couldn't be checked.
  const probe = await testSession(marketplace, headers);
  const label = marketplace === 'amazon' ? 'Amazon' : 'Myntra';
  if (probe.rejected) {
    return NextResponse.json(
      {
        error: `That ${label} session doesn't work (${probe.detail}) — it was NOT saved and the current session was kept. Copy a fresh request from a logged-in ${label} tab.`,
      },
      { status: 409 }
    );
  }

  const result = await saveSession({ marketplace, headers, source: 'manual' });
  return NextResponse.json({ ok: true, ...result, tested: !!probe.ok, warning: probe.unreachable ? `Saved, but ${label} couldn't be reached to test it (${probe.detail}).` : null });
}
