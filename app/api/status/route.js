import { NextResponse } from 'next/server';
import { getDb } from '../../../lib/db';
import { getCurrentAccount } from '../../../lib/adminAuth';
import { effectiveSections } from '../../../lib/sections';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const account = await getCurrentAccount();
  if (!account) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  // Every page asks this (the Live/Stopped pill, what the sidebar shows); the
  // Overview figures go only to someone who may open Overview.
  const sections = effectiveSections(account);
  const me = { username: account.username, role: account.role, sections };
  const db = await getDb();
  if (!sections.includes('overview')) {
    const statusDoc = await db.collection('settings').findOne({ _id: 'status' }, { projection: { running: 1 } });
    return NextResponse.json({ account: me, running: Boolean(statusDoc && statusDoc.running) });
  }
  const [sessionDoc, amazonSessionDoc, statusDoc] = await Promise.all([
    db.collection('settings').findOne({ _id: 'session' }),
    db.collection('settings').findOne({ _id: 'session_amazon' }),
    db.collection('settings').findOne({ _id: 'status' }),
  ]);

  return NextResponse.json({
    account: me,
    running: Boolean(statusDoc && statusDoc.running),
    lastCheck: statusDoc?.lastCheck ?? null,
    openCount: statusDoc?.openCount ?? null,
    lastError: statusDoc?.lastError ?? null,
    lastCancelCheck: statusDoc?.lastCancelCheck ?? null,
    cancelledCount: statusDoc?.cancelledCount ?? null,
    lastCancelError: statusDoc?.lastCancelError ?? null,
    sessionCapturedAt: sessionDoc?.capturedAt ?? null,
    amazonLastCheck: statusDoc?.amazonLastCheck ?? null,
    amazonOpenCount: statusDoc?.amazonOpenCount ?? null,
    amazonLastError: statusDoc?.amazonLastError ?? null,
    amazonSessionCapturedAt: amazonSessionDoc?.capturedAt ?? null,
    amazonLastCancelCheck: statusDoc?.amazonLastCancelCheck ?? null,
    amazonCancelledCount: statusDoc?.amazonCancelledCount ?? null,
    amazonLastCancelError: statusDoc?.amazonLastCancelError ?? null,
    myntraScrapeMode: statusDoc?.myntraScrapeMode || 'cloud',
    amazonScrapeMode: statusDoc?.amazonScrapeMode || 'cloud',
    myntraLastProxyCheck: statusDoc?.myntraLastProxyCheck ?? null,
    amazonLastProxyCheck: statusDoc?.amazonLastProxyCheck ?? null,
    myntraProxyInterval: statusDoc?.myntraProxyInterval ?? null,
    amazonProxyInterval: statusDoc?.amazonProxyInterval ?? null,
  });
}
