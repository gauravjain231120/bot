import { NextResponse } from 'next/server';
import { runCheckAmazonOrders } from '../../../../lib/checkAmazonOrders';
import { runCheckOrders } from '../../../../lib/checkOrders';

export const runtime = 'nodejs';
export const maxDuration = 45; // Need time to process database writes/Telegram alerts

import { secretMatches } from '../../../../lib/secrets';

export async function POST(req) {
  if (!secretMatches(req.headers.get('x-sync-secret'), process.env.EXTENSION_SYNC_SECRET)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  try {
    const body = await req.json();
    const { marketplace, orders } = body;

    if (!marketplace || !Array.isArray(orders)) {
      return NextResponse.json({ ok: false, error: 'Invalid payload' }, { status: 400 });
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
