import { NextResponse } from 'next/server';
import { getDb } from '../../../lib/db';
import { sendOwnerAlert } from '../../../lib/telegram';
import { runCheckAmazonOrders } from '../../../lib/checkAmazonOrders';
import { runCheckOrders } from '../../../lib/checkOrders';

export const runtime = 'nodejs';
export const maxDuration = 45; // Need time to process database writes/Telegram alerts

import { secretMatches } from '../../../lib/secrets';

export async function POST(req) {
  if (!secretMatches(req.headers.get('x-sync-secret'), process.env.EXTENSION_SYNC_SECRET)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  try {
    const body = await req.json();
    const { marketplace, type, orders, canceledOrders, stateChange, interval } = body;

    const db = await getDb();
    
    if (interval) {
      await db.collection('settings').updateOne(
        { _id: 'status' },
        { $set: { [`${marketplace}ProxyInterval`]: interval } },
        { upsert: true }
      );
    }

    if (stateChange === 'local') {
      const statusDoc = await db.collection('settings').findOne({ _id: 'status' }) || {};
      if (statusDoc[`${marketplace}ScrapeMode`] !== 'local') {
        const Name = marketplace === 'amazon' ? 'Amazon' : 'Myntra';
        await sendOwnerAlert(`💻 <b>${Name} switched to Local Browser</b>\nManual toggle turned ON.`, { silent: true }).catch(() => {});
      }
      await db.collection('settings').updateOne(
        { _id: 'status' },
        { $set: { [`${marketplace}ScrapeMode`]: 'local', [`${marketplace}LastProxyCheck`]: new Date().toISOString() } },
        { upsert: true }
      );
      return NextResponse.json({ ok: true, status: 'local-forced' });
    }

    
    if (stateChange === 'logout') {
      const statusDoc = await db.collection('settings').findOne({ _id: 'status' }) || {};
      const Name = marketplace === 'amazon' ? 'Amazon' : 'Myntra';
      if (!statusDoc[`${marketplace}LogoutAlertSent`]) {
        await sendOwnerAlert(`🚨 <b>${Name} logged out</b>\nPlease log in to ${Name} in this Chrome again.`, { silent: false }).catch(() => {});
        await db.collection('settings').updateOne(
          { _id: 'status' },
          { $set: { [`${marketplace}LogoutAlertSent`]: true, [`${marketplace}ScrapeMode`]: 'cloud', [`${marketplace}LastProxyCheck`]: null } },
          { upsert: true }
        );
      }
      return NextResponse.json({ ok: true, status: 'logout-recorded' });
    }
    if (stateChange === 'cloud') {
      const statusDoc = await db.collection('settings').findOne({ _id: 'status' }) || {};
      if (statusDoc[`${marketplace}ScrapeMode`] === 'local') {
        const Name = marketplace === 'amazon' ? 'Amazon' : 'Myntra';
        await sendOwnerAlert(`☁️ <b>${Name} switched to Cloud Backup</b>\nManual toggle turned OFF.`, { silent: true }).catch(() => {});
      }
      await db.collection('settings').updateOne(
        { _id: 'status' },
        { $set: { [`${marketplace}ScrapeMode`]: 'cloud', [`${marketplace}LastProxyCheck`]: null } },
        { upsert: true }
      );
      return NextResponse.json({ ok: true, status: 'cloud-forced' });
    }

    if (canceledOrders) {
      await db.collection('settings').updateOne(
        { _id: `proxy_canceled_${marketplace}` },
        { $set: { data: canceledOrders, updatedAt: new Date().toISOString() } },
        { upsert: true }
      );
    }

    if (type === 'test') {
       // testing logic is handled by proxy-test route, this shouldn't normally hit
       return NextResponse.json({ ok: true, test: true });
    }

    if (!marketplace || !Array.isArray(orders)) {
      return NextResponse.json({ ok: false, error: 'Invalid payload' }, { status: 400 });
    }

    
    if (marketplace && Array.isArray(orders)) {
      await db.collection('settings').updateOne(
        { _id: 'status' },
        { $unset: { [`${marketplace}LogoutAlertSent`]: "" } }
      );
    }

    if (marketplace === 'amazon') {
      await runCheckAmazonOrders({ proxyData: orders });
    } else if (marketplace === 'myntra') {
      await runCheckOrders({ proxyData: orders });
    } else {
      return NextResponse.json({ ok: false, error: 'Unknown marketplace' }, { status: 400 });
    }

    return NextResponse.json({ ok: true, count: orders.length });
  } catch (err) {
    console.error('Proxy submit failed:', err);
    return NextResponse.json({ ok: false, error: err.message }, { status: 500 });
  }
}