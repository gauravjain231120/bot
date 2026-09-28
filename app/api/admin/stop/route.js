import { NextResponse } from 'next/server';
import { getDb } from '../../../../lib/db';
import { setRunning } from '../../../../lib/monitorState';
import { requireSection } from '../../../../lib/access';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST() {
  const access = await requireSection('controls');
  if (!access.ok) return NextResponse.json({ error: access.error }, { status: access.status });

  const db = await getDb();
  await setRunning(db, false);
  // Precise start time for the "stopped too long" watchdog, rather than
  // letting it self-heal to whenever the next cron tick happens to notice.
  await db.collection('settings').updateOne(
    { _id: 'status' },
    { $set: { stoppedAt: new Date().toISOString() }, $unset: { stoppedAlertSent: '' } },
    { upsert: true }
  );

  return NextResponse.json({ running: false });
}
