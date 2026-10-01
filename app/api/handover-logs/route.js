import { NextResponse } from 'next/server';
import { getDb } from '../../../lib/db';
import { requireSection } from '../../../lib/access';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request) {
  const access = await requireSection('handovers');
  if (!access.ok) return NextResponse.json({ error: access.error }, { status: access.status });

  try {
    const db = await getDb();
    const logs = await db.collection('handover_logs')
      .find({})
      .sort({ date: -1 })
      .limit(100)
      .toArray();

    return NextResponse.json({ logs });
  } catch (err) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
