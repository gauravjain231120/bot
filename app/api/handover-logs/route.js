import { NextResponse } from 'next/server';
import { getDb } from '../../../lib/db';
import { requireSection } from '../../../lib/access';
import { verifyPassword } from '../../../lib/accounts';

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

export async function PUT(request) {
  const access = await requireSection('handovers');
  if (!access.ok) return NextResponse.json({ error: access.error }, { status: access.status });

  try {
    const data = await request.json();
    const { date, mysDevice, mysReceived, mysNotes, myeDevice, myeReceived, myeNotes, password } = data;

    const isValid = await verifyPassword(access.account.username, password);
    if (!isValid) {
      return NextResponse.json({ error: 'Incorrect password. Use your login password.' }, { status: 401 });
    }

    if (!date) return NextResponse.json({ error: 'Date required' }, { status: 400 });

    const db = await getDb();
    const update = { date, updatedAt: new Date() };
    
    if (mysDevice !== undefined) update.mysDevice = mysDevice === '' ? null : Number(mysDevice);
    if (mysReceived !== undefined) update.mysReceived = mysReceived === '' ? null : Number(mysReceived);
    if (mysNotes !== undefined) update.mysNotes = mysNotes;

    if (myeDevice !== undefined) update.myeDevice = myeDevice === '' ? null : Number(myeDevice);
    if (myeReceived !== undefined) update.myeReceived = myeReceived === '' ? null : Number(myeReceived);
    if (myeNotes !== undefined) update.myeNotes = myeNotes;

    await db.collection('handover_logs').updateOne(
      { _id: date },
      { 
        $set: update,
        $setOnInsert: { createdAt: new Date() }
      },
      { upsert: true }
    );

    return NextResponse.json({ success: true });
  } catch (err) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

export async function DELETE(request) {
  const access = await requireSection('handovers');
  if (!access.ok) return NextResponse.json({ error: access.error }, { status: access.status });

  try {
    const data = await request.json();
    const { date, password } = data;

    const isValid = await verifyPassword(access.account.username, password);
    if (!isValid) {
      return NextResponse.json({ error: 'Incorrect password. Use your login password.' }, { status: 401 });
    }

    if (!date) return NextResponse.json({ error: 'Date required' }, { status: 400 });

    const db = await getDb();
    await db.collection('handover_logs').deleteOne({ _id: date });

    return NextResponse.json({ success: true });
  } catch (err) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
