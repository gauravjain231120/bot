import { NextResponse } from 'next/server';
import { saveSessionHeaders, announceSessionActivated, announceScheduledSyncOk } from '../../../../lib/sessionStore';
import { getDb } from '../../../../lib/db';
import { fetchUnshippedOrders } from '../../../../lib/amazon';
import { fetchOpenOrders } from '../../../../lib/myntra';

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
  const label = marketplace === 'amazon' ? 'Amazon' : 'Myntra';
  // 'manual' means a person clicked Sync in the popup right now, asking
  // "does this work?". Anything else (omitted, or 'auto') is the unattended
  // timer or a backoff retry, happening on its own with no way to know if
  // anything changed.
  const trigger = body.trigger === 'manual' ? 'manual' : 'auto';

  try {
    const result = await saveSessionHeaders({ marketplace, headers: body.headers, source: 'extension' });

    let working;
    let rawError;

    if (trigger === 'manual') {
      // A person explicitly asked "does this work right now?" — the
      // ~1-minute poller's last recorded result can be up to a minute
      // stale (e.g. you logged out of Amazon seconds ago and the poll just
      // before that still said fine), which is exactly what made a manual
      // click right after logging out still say "ok", then separately say
      // "activated" even though the session was already broken. A manual
      // click is rare enough (nothing like the once-a-minute unattended
      // cadence) that it's worth a real, live probe against the actual API
      // instead of trusting that stale status.
      try {
        if (marketplace === 'amazon') await fetchUnshippedOrders(body.headers);
        else await fetchOpenOrders(body.headers);
        working = true;
      } catch (err) {
        working = false;
        const status = err.response && err.response.status;
        rawError = `${new Date().toISOString()} HTTP ${status || ''} ${err.message}`;
      }
    } else {
      // Unattended sync: piggyback on the poller's own last recorded result
      // rather than adding an extra live API call to every retry/period.
      const db = await getDb();
      const statusDoc = await db.collection('settings').findOne({ _id: 'status' });
      rawError = marketplace === 'amazon' ? statusDoc?.amazonLastError : statusDoc?.lastError;
      working = !rawError;
    }

    if (!working) {
      // rawError is a log line (e.g. "2026-09-14T13:08:21.119Z HTTP 403
      // Request failed with status code 403") meant for the admin page, not
      // a tiny extension popup row — it gets cut off mid-timestamp there and
      // reads as gibberish. Translate it into something short and
      // actionable; the raw line still comes along as `detail` for anyone
      // who needs it (e.g. a future debugging pass), just not shown by the
      // extension today.
      const isAuthFailure = /HTTP 401|HTTP 403/.test(rawError || '');
      const friendly = isAuthFailure
        ? `${label} session expired — log in to ${label} in THIS Chrome browser (being logged in elsewhere doesn't count)`
        : `${label} check failed — see the admin page for details`;
      return NextResponse.json({ error: friendly, detail: rawError }, { status: 401 });
    }

    // Genuinely verified working — never announced on the basis of "cookies
    // were accepted" alone. A manual click that turns out to actually work
    // is worth telling you about and worth re-arming the expired-alert (so
    // you're told again if it breaks later). The unattended timer never
    // does THAT flag-touching announcement itself — the poller's own success
    // path already resets the alert flag when it finds things working, and
    // re-announcing it here too on every clean auto-sync is exactly what
    // caused the earlier spam loop of alternating activated/expired messages.
    //
    // A scheduled (never retry) auto-sync still gets its own quiet, flag-free
    // heartbeat instead — see announceScheduledSyncOk's doc comment for why
    // that one can't reintroduce the same loop.
    if (trigger === 'manual') {
      await announceSessionActivated(marketplace);
    } else if (body.scheduled) {
      await announceScheduledSyncOk(marketplace);
    }

    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    return NextResponse.json({ error: err.message }, { status: 400 });
  }
}
