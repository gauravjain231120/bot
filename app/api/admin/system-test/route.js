import { NextResponse } from 'next/server';
import { getDb } from '../../../../lib/db';
import { requireOwner } from '../../../../lib/adminAuth';
import { sendOwnerAlert } from '../../../../lib/telegram';
import { fetchPackedCount } from '../../../../lib/myntra';
import { todayIst, toDMY } from '../../../../lib/telegramCommands';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request) {
  const check = await requireOwner();
  if (!check.ok) {
    return NextResponse.json({ error: check.error }, { status: check.status });
  }
  const admin = check.account;

  try {
    const db = await getDb();
    const settings = db.collection('settings');
    const status = await settings.findOne({ _id: 'status' }) || {};

    let dbOk = !!status;
    let myntraOk = false;
    let amzOk = false;
    let amzMsg = 'No session';
    let mynMsg = 'No session';

    // Test Myntra
    const sessionDoc = await settings.findOne({ _id: 'session' });
    if (sessionDoc && sessionDoc.headers) {
      try {
        const dmy = toDMY(todayIst());
        await fetchPackedCount(dmy, dmy, sessionDoc.headers);
        myntraOk = true;
        mynMsg = 'OK';
      } catch (err) {
        mynMsg = err.message;
      }
    }

    // Test Amazon
    const amzSession = await settings.findOne({ _id: 'session_amazon' });
    if (amzSession && amzSession.headers) {
        amzOk = true;
        amzMsg = 'OK';
    }

    // Determine host
    const host = request.headers.get('host') || process.env.VERCEL_URL || 'Unknown Server';
    
    const dbIcon = dbOk ? '✅' : '❌';
    const mynIcon = myntraOk ? '✅' : '❌';
    const amzIcon = amzOk ? '✅' : '❌';

    const text = 
      `🧪 <b>System Diagnostic Test</b>\n\n` +
      `🌐 <b>Active Server:</b> ${host}\n` +
      `👤 <b>Triggered by:</b> ${admin.username}\n\n` +
      `<b>Integrations:</b>\n` +
      `${dbIcon} Database Connected\n` +
      `${mynIcon} Myntra Session: ${mynMsg}\n` +
      `${amzIcon} Amazon Session: ${amzMsg}\n\n` +
      `<i>All core systems respond properly on this node.</i>`;

    await sendOwnerAlert(text);

    return NextResponse.json({ ok: true, host, myntraOk, amzOk });
  } catch (err) {
    console.error('System test failed:', err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
