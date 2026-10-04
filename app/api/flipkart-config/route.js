import { NextResponse } from 'next/server';
import { getDb } from '../../../lib/db';

export const runtime = 'nodejs';

export async function GET() {
  const db = await getDb();
  const config = await db.collection('settings').findOne({ _id: 'flipkart_config' });
  return NextResponse.json({ enabled: !!(config && config.enabled) });
}

export async function POST(req) {
  const body = await req.json();
  const enabled = !!body.enabled;
  const db = await getDb();
  await db.collection('settings').updateOne(
    { _id: 'flipkart_config' },
    { $set: { enabled, updatedAt: new Date().toISOString() } },
    { upsert: true }
  );
  return NextResponse.json({ ok: true, enabled });
}
