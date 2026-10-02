import { NextResponse } from 'next/server';
import { getDb } from '../../../lib/db';
import { getCurrentAccount } from '../../../lib/adminAuth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const account = await getCurrentAccount();
  if (!account) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  const db = await getDb();
  const logs = await db.collection('engineLogs').find({}).sort({ createdAt: -1 }).limit(100).toArray();
  
  return NextResponse.json({ logs });
}
