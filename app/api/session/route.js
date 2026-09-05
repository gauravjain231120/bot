import { NextResponse } from 'next/server';
import { getDb } from '../../../lib/db';
import { parseCurl } from '../../../lib/curl';
import { isAuthed } from '../../../lib/adminAuth';
import { recordSessionCaptured } from '../../../lib/sessionHistory';
import { replyToChat } from '../../../lib/telegram';
import { formatIST } from '../../../lib/dates';

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

  const isAmazon = marketplace === 'amazon';
  const sessionId = isAmazon ? 'session_amazon' : 'session';
  const expiredFlag = isAmazon ? 'amazonSessionExpiredAlertSent' : 'sessionExpiredAlertSent';

  const db = await getDb();
  await db.collection('settings').updateOne(
    { _id: sessionId },
    { $set: { headers, capturedAt: new Date().toISOString() } },
    { upsert: true }
  );
  await db.collection('settings').updateOne(
    { _id: 'status' },
    { $set: { [expiredFlag]: false } },
    { upsert: true }
  );
  await recordSessionCaptured(isAmazon ? 'amazon' : 'myntra');

  // Mirrors the session-expired alert: goes ONLY to the primary chat, not the
  // broadcast list — this is a "you just did something" confirmation for
  // whoever pasted the session, not order-alert-style news for everyone.
  const label = isAmazon ? 'Amazon' : 'Myntra';
  await replyToChat(
    process.env.TELEGRAM_COMMAND_CHAT_ID,
    `✅ <b>${label} session activated</b>\n${formatIST(Date.now())}`
  ).catch((err) => console.error('session-activated alert failed:', err.message));

  return NextResponse.json({ ok: true, headerCount: Object.keys(headers).length });
}
