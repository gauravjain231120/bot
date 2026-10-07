
import { NextResponse } from 'next/server';
import { getDb } from '../../../lib/db';
import { sendOwnerAlert } from '../../../lib/telegram';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request) {
  try {
    const data = await request.json();
    const { date, type, rApp, rReceived, notes } = data;

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
      [`${prefix}Notes`]: notes,
      [`${prefix}RApp`]: rApp,
      [`${prefix}RReceived`]: rReceived,
      [`${prefix}HasReturn`]: true,
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
      expectMys = Boolean(otcStatus.values.returnMys);
      expectMye = Boolean(otcStatus.values.returnMye);
    } else {
      expectMys = type === 'MYS';
      expectMye = type === 'MYE';
    }

    const checkFilled = (prefix) => {
      // It's filled if they have submitted the form (which sets HasReturn) AND the required fields are filled.
      if (log[`${prefix}HasReturn`] === undefined) return false;
      return log[`${prefix}RApp`] != null && log[`${prefix}RReceived`] != null;
    };

    const mysFilled = checkFilled('mys');
    const myeFilled = checkFilled('mye');

    if (expectMys && !mysFilled) return NextResponse.json({ success: true, pending: true });
    if (expectMye && !myeFilled) return NextResponse.json({ success: true, pending: true });

    let msg = `📦 <b>Courier Return Logged</b> (${date})\n\n`;
    let hasDiscrepancy = false;
    const notesArr = [];
    
    const flag = (a, b) => (a !== b ? ' ❌' : ' ✅');

    const appendLog = (prefix, label) => {
      if (log[`${prefix}HasReturn`]) {
        const ra = log[`${prefix}RApp`];
        const rr = log[`${prefix}RReceived`];
        msg += `<b>${label} Return:</b> ${rr}/${ra}${flag(ra, rr)}\n`;
        if (ra !== rr) hasDiscrepancy = true;
      }
      if (log[`${prefix}Notes`]) notesArr.push(`${label}: ${log[`${prefix}Notes`]}`);
    };

    if (expectMys && mysFilled) appendLog('mys', 'MYS');
    if (expectMye && myeFilled) appendLog('mye', 'MYE');

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
