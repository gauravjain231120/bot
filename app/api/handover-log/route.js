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

    // Read full log to check if everything is filled
    const log = await db.collection('handover_logs').findOne({ _id: date });
    const otcStatus = await db.collection('settings').findOne({ _id: 'otc_status' });
    
    let expectMys = false;
    let expectMye = false;
    
    if (otcStatus && otcStatus.alertedDate === date && otcStatus.values) {
      expectMys = Boolean(otcStatus.values.pickupMys || otcStatus.values.returnMys);
      expectMye = Boolean(otcStatus.values.pickupMye || otcStatus.values.returnMye);
    } else {
      // Fallback: If we don't have OTC status for this exact date, 
      // just expect whatever they just submitted to be the only thing.
      expectMys = type === 'MYS';
      expectMye = type === 'MYE';
    }

    const mysFilled = log.mysDevice != null && log.mysReceived != null;
    const myeFilled = log.myeDevice != null && log.myeReceived != null;

    // Wait until all expected fields are filled before sending the summary
    if (expectMys && !mysFilled) return NextResponse.json({ success: true, pending: true });
    if (expectMye && !myeFilled) return NextResponse.json({ success: true, pending: true });

    // Send combined telegram message
    let msg = `📦 <b>Courier Handover Logged</b> (${date})\n\n`;
    let hasDiscrepancy = false;
    const notesArr = [];
    
    const flag = (dev, rec) => (dev !== rec ? ' ❌' : ' ✅');

    if (expectMys && mysFilled) {
      msg += `<b>MYS:</b> ${log.mysReceived}/${log.mysDevice}${flag(log.mysDevice, log.mysReceived)}\n`;
      if (log.mysDevice !== log.mysReceived) hasDiscrepancy = true;
      if (log.mysNotes) notesArr.push(`MYS: ${log.mysNotes}`);
    }

    if (expectMye && myeFilled) {
      msg += `<b>MYE:</b> ${log.myeReceived}/${log.myeDevice}${flag(log.myeDevice, log.myeReceived)}\n`;
      if (log.myeDevice !== log.myeReceived) hasDiscrepancy = true;
      if (log.myeNotes) notesArr.push(`MYE: ${log.myeNotes}`);
    }

    if (notesArr.length > 0) {
      msg += `\n<i>Notes: ${notesArr.join(' | ')}</i>`;
    }
    
    if (hasDiscrepancy) {
      msg += `\n\n⚠️ <b>Discrepancy detected!</b> Check with the courier or raise a dispute.`;
    }

    await sendOwnerAlert(msg);

    return NextResponse.json({ success: true });
  } catch (err) {
    console.error('Handover log error:', err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
