
import { NextResponse } from 'next/server';
import { getDb } from '../../../lib/db';
import { sendOwnerAlert } from '../../../lib/telegram';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request) {
  try {
    const data = await request.json();
    const { date, type, hasPickup, hasReturn, pDevice, pHandover, rApp, rReceived, notes } = data;

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
      [`${prefix}HasPickup`]: hasPickup,
      [`${prefix}HasReturn`]: hasReturn,
    };
    if (hasPickup) {
      updateFields[`${prefix}PDevice`] = pDevice;
      updateFields[`${prefix}PHandover`] = pHandover;
    }
    if (hasReturn) {
      updateFields[`${prefix}RApp`] = rApp;
      updateFields[`${prefix}RReceived`] = rReceived;
    }

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
      expectMys = type === 'MYS';
      expectMye = type === 'MYE';
    }

    const checkFilled = (prefix) => {
      const pFilled = !log[`${prefix}HasPickup`] || (log[`${prefix}PDevice`] != null && log[`${prefix}PHandover`] != null);
      const rFilled = !log[`${prefix}HasReturn`] || (log[`${prefix}RApp`] != null && log[`${prefix}RReceived`] != null);
      // It's filled if they have submitted the form (which sets HasPickup/HasReturn) AND the required fields are filled.
      // If HasPickup is undefined in DB, it means they haven't submitted this type yet.
      if (log[`${prefix}HasPickup`] === undefined && log[`${prefix}HasReturn`] === undefined) return false;
      return pFilled && rFilled;
    };

    const mysFilled = checkFilled('mys');
    const myeFilled = checkFilled('mye');

    if (expectMys && !mysFilled) return NextResponse.json({ success: true, pending: true });
    if (expectMye && !myeFilled) return NextResponse.json({ success: true, pending: true });

    let msg = `📦 <b>Courier Handover Logged</b> (${date})\n\n`;
    let hasDiscrepancy = false;
    const notesArr = [];
    
    const flag = (a, b) => (a !== b ? ' ❌' : ' ✅');

    const appendLog = (prefix, label) => {
      let block = '';
      if (log[`${prefix}HasPickup`]) {
        const pd = log[`${prefix}PDevice`];
        const ph = log[`${prefix}PHandover`];
        block += `<b>${label} Pickup:</b> ${ph}/${pd}${flag(pd, ph)}\n`;
        if (pd !== ph) hasDiscrepancy = true;
      }
      if (log[`${prefix}HasReturn`]) {
        const ra = log[`${prefix}RApp`];
        const rr = log[`${prefix}RReceived`];
        block += `<b>${label} Return:</b> ${rr}/${ra}${flag(ra, rr)}\n`;
        if (ra !== rr) hasDiscrepancy = true;
      }
      if (block) msg += block;
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
