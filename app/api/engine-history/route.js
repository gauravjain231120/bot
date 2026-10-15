import { NextResponse } from 'next/server';
import { getDb } from '../../../lib/db';
import { requireSection } from '../../../lib/access';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const check = await requireSection('engine');
  if (!check.ok) return NextResponse.json({ error: check.error }, { status: check.status });

  const db = await getDb();
  const logs = await db.collection('engineLogs').find({}).sort({ createdAt: -1 }).limit(1000).toArray();
  
  return NextResponse.json({ logs });
}
