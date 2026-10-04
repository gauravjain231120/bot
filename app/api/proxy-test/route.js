import { NextResponse } from 'next/server';
import { getDb } from '../../../lib/db';
import { secretMatches } from '../../../lib/secrets';
import { sendOwnerAlert } from '../../../lib/telegram';
import { fetchUnshippedByProgram } from '../../../lib/amazon';
import { fetchOpenOrders } from '../../../lib/myntra';
import { fetchFlipkartOrders } from '../../../lib/flipkart';

export const runtime = 'nodejs';
export const maxDuration = 45;

export async function POST(req) {
  if (!secretMatches(req.headers.get('x-sync-secret'), process.env.EXTENSION_SYNC_SECRET)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  try {
    const body = await req.json();
    const { marketplace, type, orders } = body;
    const label = marketplace === 'amazon' ? 'Amazon' : marketplace === 'flipkart' ? 'Flipkart' : 'Myntra';

    if (type === 'local') {
      // Local Test: The extension already fetched the orders and handed them to us
      const count = Array.isArray(orders) ? orders.length : 0;
      await sendOwnerAlert(
        `✅ <b>${label} Local Check Test Successful!</b>\nYour browser successfully connected to ${label} and fetched ${count} orders.`
      );
      return NextResponse.json({ ok: true, count, message: 'Local check successful' });
    } 
    
    if (type === 'cloud') {
      // Cloud Test: We must fetch them ourselves from Vercel using saved cookies
      const db = await getDb();
      const sessionDoc = await db.collection('settings').findOne({ _id: marketplace === 'amazon' ? 'session_amazon' : marketplace === 'flipkart' ? 'session_flipkart' : 'session' });
      
      if (!sessionDoc || !sessionDoc.headers) {
        await sendOwnerAlert(`❌ <b>${label} Cloud Check Test Failed!</b>\nNo session is saved on the server.`);
        return NextResponse.json({ ok: false, message: 'No session saved' });
      }

      try {
        let fetchedOrders = [];
        if (marketplace === 'amazon') {
          const results = await fetchUnshippedByProgram(sessionDoc.headers);
          fetchedOrders = Object.values(results).flat();
        } else if (marketplace === 'flipkart') {
          const results = await fetchFlipkartOrders(sessionDoc.headers);
          fetchedOrders = results.orders || [];
        } else {
          fetchedOrders = await fetchOpenOrders(sessionDoc.headers);
        }
        
        await sendOwnerAlert(
          `✅ <b>${label} Cloud Check Test Successful!</b>\nVercel's cloud server successfully connected and fetched ${fetchedOrders.length} orders.`
        );
        return NextResponse.json({ ok: true, count: fetchedOrders.length, message: 'Cloud check successful' });
        
      } catch (err) {
        const status = err.response ? err.response.status : 'Unknown';
        await sendOwnerAlert(
          `❌ <b>${label} Cloud Check Test Failed!</b>\nVercel's cloud server was blocked or rejected.\nReason: HTTP ${status} - ${err.message}`
        );
        return NextResponse.json({ ok: false, message: `Cloud blocked (HTTP ${status})` });
      }
    }

    return NextResponse.json({ ok: false, error: 'Invalid test type' }, { status: 400 });
  } catch (err) {
    console.error('Proxy test failed:', err);
    return NextResponse.json({ ok: false, error: err.message }, { status: 500 });
  }
}
