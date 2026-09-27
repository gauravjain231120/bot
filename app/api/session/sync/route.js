import { NextResponse } from 'next/server';
import {
  saveSessionHeaders,
  announceSessionActivated,
  announceScheduledSyncOk,
  markSessionRestored,
  clearSessionError,
  isSameWorkingLogin,
} from '../../../../lib/sessionStore';
import { testSession } from '../../../../lib/sessionProbe';

export const runtime = 'nodejs';
// Testing a dead Amazon session can take ~10s+ (Amazon's 403s are retried) —
// don't let the platform's default timeout cut the test short.
export const maxDuration = 30;

const MIN_PERIOD = 15;
const MAX_PERIOD = 24 * 60;

/**
 * POST /api/session/sync — the browser-extension equivalent of pasting a
 * session on the admin page. The extension reads the (HttpOnly) cookies
 * straight from Chrome's cookie jar and posts them here.
 *
 * body: { marketplace, headers, trigger, scheduled, periodMinutes }
 *   trigger 'manual'   — someone clicked Sync in the popup
 *           'auto'     — the extension's own timer (scheduled: true for the
 *                        main per-marketplace alarm and its backoff retries),
 *                        or a new login just appeared in the browser
 *                        (scheduled: false)
 *           'recovery' — the extension saw (via /api/session/health) that the
 *                        bot's session expired while the browser is still
 *                        logged in, and is re-syncing right away
 *
 * The rule for every trigger: the new session is TESTED FIRST (one live
 * call) and only saved if it actually works. It used to be saved
 * unconditionally, so a browser that had logged out (or whose copy had gone
 * stale) could overwrite a perfectly working session and break the bot. Now
 * a non-working one is refused with reason 'session-not-working' and the
 * current session is left exactly as it was — the extension then knows the
 * browser needs a real login and stops re-trying that same copy.
 *
 * Every sync — scheduled ones included — replaces the bot's copy with the
 * browser's once it tests OK. Unattended syncs of the "same login" used to
 * be skipped (the bot's own rolling copy was assumed fresher). For Amazon
 * that was wrong: the browser's login tokens stay the same for days, so the
 * bot's copy was never refreshed and kept dying ~10 h after capture while
 * Chrome stayed logged in (sessionLifetimes: 599 / 600 / 619 min in a row,
 * each followed by an "expired" alert and an extension restore). One test
 * call per sync (every 4 h by default) keeps it fresh.
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
  if (!body || typeof body.headers !== 'object' || !body.headers) {
    return NextResponse.json({ error: 'missing headers' }, { status: 400 });
  }

  const marketplace = body.marketplace === 'amazon' ? 'amazon' : 'myntra';
  const label = marketplace === 'amazon' ? 'Amazon' : 'Myntra';
  const trigger = ['manual', 'recovery'].includes(body.trigger) ? body.trigger : 'auto';
  const period = Number(body.periodMinutes);
  const syncPeriodMinutes = Number.isFinite(period) ? Math.min(MAX_PERIOD, Math.max(MIN_PERIOD, Math.round(period))) : null;

  // Only for a manual ↻'s wording ("working, same login" vs "activated").
  const sameLogin = trigger === 'manual' && (await isSameWorkingLogin(marketplace, body.headers));

  // 1. Test the browser's session before touching the stored one. Only a
  // genuine rejection counts as "not working" (lib/sessionProbe.js); a bot-
  // protection block or network error says nothing about the session, so it's
  // "couldn't test, retry later", never "logged out".
  const probe = await testSession(marketplace, body.headers);
  if (probe.rejected) {
    return NextResponse.json(
      {
        error: `${label} session in this browser isn't working — log in to ${label} again in THIS Chrome browser. The bot kept its current session.`,
        reason: 'session-not-working',
        detail: probe.detail,
      },
      { status: 409 }
    );
  }
  if (probe.unreachable) {
    return NextResponse.json(
      { error: `${label} couldn't be reached to test the session — will retry`, reason: 'probe-failed', detail: probe.detail },
      { status: 502 }
    );
  }

  // 2. It works — store it.
  try {
    const result = await saveSessionHeaders({ marketplace, headers: body.headers, source: 'extension', syncPeriodMinutes });

    if (trigger === 'manual') {
      // A person explicitly asked "does this work?" — confirm it and re-arm
      // the expired alert (same as always).
      await clearSessionError(marketplace);
      await announceSessionActivated(marketplace, { alreadyActive: sameLogin });
    } else if (trigger === 'recovery') {
      await markSessionRestored(marketplace);
    } else {
      await clearSessionError(marketplace);
      // Quiet ~4-hourly heartbeat; never touches the alert flags, so a retry
      // storm can't turn it into the old activated/expired spam loop.
      if (body.scheduled) await announceScheduledSyncOk(marketplace, syncPeriodMinutes);
    }

    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    return NextResponse.json({ error: err.message }, { status: 400 });
  }
}
