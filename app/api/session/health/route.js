import { NextResponse } from 'next/server';
import { getDb } from '../../../../lib/db';
import { secretMatches } from '../../../../lib/secrets';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// GET /api/session/health — polled by the browser extension every minute to
// ask "is the bot's Myntra / Amazon session still working?". Reads ONLY this
// app's own database (what the 5-minute checks last recorded) — never calls
// Myntra or Amazon, so polling it often costs the marketplace accounts
// nothing. Same shared secret as /api/session/sync.
//
// state per marketplace:
//   ok       last check worked
//   expired  last check was rejected (HTTP 401/403 / Myntra's "session
//            expired") — the extension re-syncs if the browser is still
//            logged in
//   missing  no session saved at all
//   error    last check failed some other way (network, 5xx) — a re-sync
//            wouldn't fix that, so the extension leaves it alone
function stateFor(sessionDoc, lastError) {
  if (!sessionDoc || !sessionDoc.headers) return 'missing';
  if (!lastError) return 'ok';
  if (/HTTP 40[13]\b|expired|sign.?in/i.test(lastError)) return 'expired';
  return 'error';
}

export async function GET(request) {
  if (!secretMatches(request.headers.get('x-sync-secret'), process.env.EXTENSION_SYNC_SECRET)) {
    return NextResponse.json({
    warehouseId: process.env.WAREHOUSE_ID || '89623', error: 'unauthorized' }, { status: 401 });
  }

  const db = await getDb();
  const settings = db.collection('settings');
  const projection = { capturedAt: 1, source: 1, headers: 1, cookiesRolledAt: 1 };
  const [status, myntra, amazon, flipkart] = await Promise.all([
    settings.findOne({ _id: 'status' }),
    settings.findOne({ _id: 'session' }, { projection }),
    settings.findOne({ _id: 'session_amazon' }, { projection }),
    settings.findOne({ _id: 'session_flipkart' }, { projection }),
  ]);
  const st = status || {};
  // Remember which extension build is polling (written only when it changes).
  const version = String(request.headers.get('x-extension-version') || '').slice(0, 20);
  if (version && st.extensionVersion !== version) {
    await settings.updateOne({ _id: 'status' }, { $set: { extensionVersion: version } }, { upsert: true });
  }

  return NextResponse.json({
    running: st.running !== false,
    at: new Date().toISOString(),
    myntra: {
      state: stateFor(myntra, st.lastError),
      lastCheck: st.lastCheck || null,
      capturedAt: (myntra && myntra.capturedAt) || null,
      cookiesRefreshedAt: (myntra && myntra.cookiesRolledAt) || null,
    },
    amazon: {
      state: stateFor(amazon, st.amazonLastError),
      lastCheck: st.amazonLastCheck || null,
      capturedAt: (amazon && amazon.capturedAt) || null,
    },
    flipkart: {
      state: stateFor(flipkart, st.flipkartLastError),
      lastCheck: st.flipkartLastCheck || null,
      capturedAt: (flipkart && flipkart.capturedAt) || null,
    },
  });
}
