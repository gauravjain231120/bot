import { NextResponse } from 'next/server';
import { runCheckOrders } from '../../../lib/checkOrders';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Called by an external scheduler (cron-job.org, Vercel Cron, Inngest, ...).
// Protected by a shared secret in the query string since it's a public URL.
export async function GET(request) {
  const secret = request.nextUrl.searchParams.get('secret');
  if (!process.env.CRON_SECRET || secret !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  try {
    const result = await runCheckOrders();
    return NextResponse.json(result);
  } catch (err) {
    const status = err.status === 401 || err.status === 403 ? 401 : 500;
    return NextResponse.json({ error: err.message }, { status });
  }
}
