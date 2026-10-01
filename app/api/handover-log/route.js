import { NextResponse } from 'next/server';
import { getDb } from '../../../lib/db';
import { sendOwnerAlert } from '../../../lib/telegram';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request) {
  try {
    const data = await request.json();
    const { date, type, device, received, notes } = data;

    if (!date) {
      return NextResponse.json({ error: 'Date is required' }, { status: 400 });
    }
    if (type !== 'MYS' && type !== 'MYE') {
      return NextResponse.json({ error: 'Invalid type' }, { status: 400 });
    }

    const db = await getDb();
    
    // Set fields for the specific type
    const prefix = type.toLowerCase();
    const updateFields = {
      [`${prefix}Device`]: device,
      [`${prefix}Received`]: received,
      [`${prefix}Notes`]: notes,
    };

    // Save to database
    await db.collection('handover_logs').updateOne(
      { _id: date },
      { 
        $set: { 
          date, 
          ...updateFields,
          updatedAt: new Date()
        },
        $setOnInsert: { createdAt: new Date() }
      },
      { upsert: true }
    );

    // Send telegram message
    const flag = device !== received ? ' ❌' : ' ✅';
    let msg = `📦 <b>Courier Handover Logged</b> (${date})\n\n`;
    msg += `<b>${type}:</b> ${received}/${device}${flag}\n`;
    
    if (notes) {
      msg += `\n<i>Notes: ${notes}</i>`;
    }
    
    if (device !== received) {
      msg += `\n\n⚠️ <b>Discrepancy detected!</b> Check with the courier or raise a dispute.`;
    }

    await sendOwnerAlert(msg);

    return NextResponse.json({ success: true });
  } catch (err) {
    console.error('Handover log error:', err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
