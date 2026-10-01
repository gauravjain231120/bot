import { NextResponse } from 'next/server';
import { getDb } from '../../../lib/db';
import { sendOwnerAlert } from '../../../lib/telegram';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request) {
  try {
    const data = await request.json();
    const { date, mysDevice, mysReceived, myeDevice, myeReceived, notes } = data;

    if (!date) {
      return NextResponse.json({ error: 'Date is required' }, { status: 400 });
    }

    const db = await getDb();
    
    // Save to database
    await db.collection('handover_logs').updateOne(
      { _id: date },
      { 
        $set: { 
          date, 
          mysDevice, mysReceived, 
          myeDevice, myeReceived, 
          notes,
          updatedAt: new Date()
        },
        $setOnInsert: { createdAt: new Date() }
      },
      { upsert: true }
    );

    // Send telegram message
    let msg = `📦 <b>Courier Handover Logged</b> (${date})\n\n`;
    
    const flag = (dev, rec) => (dev !== rec ? ' ❌' : ' ✅');
    
    msg += `<b>MYS:</b> ${mysReceived}/${mysDevice}${flag(mysDevice, mysReceived)}\n`;
    msg += `<b>MYE:</b> ${myeReceived}/${myeDevice}${flag(myeDevice, myeReceived)}\n`;
    
    if (notes) {
      msg += `\n<i>Notes: ${notes}</i>`;
    }
    
    // Check if discrepancy
    if (mysDevice !== mysReceived || myeDevice !== myeReceived) {
      msg += `\n\n⚠️ <b>Discrepancy detected!</b> Check with the courier or raise a dispute.`;
    }

    await sendOwnerAlert(msg);

    return NextResponse.json({ success: true });
  } catch (err) {
    console.error('Handover log error:', err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
