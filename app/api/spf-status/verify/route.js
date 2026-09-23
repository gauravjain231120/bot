import { NextResponse } from 'next/server';
import { getDb } from '../../../../lib/db';
import { requireOwner } from '../../../../lib/adminAuth';
import { fetchSpfPaidBreakdown } from '../../../../lib/spfPaid';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// The SPF Status page already loads total/approved/paid/rejected counts
// client-side as soon as an Owner opens it — for those, this route isn't a
// data boundary, they're already in the page's own state by the time
// someone clicks a stat card. It's the same "second, separate password on
// top of the dashboard login itself" friction used for Team/Recipients
// (app/api/accounts/route.js's checkConfirmPassword) — just gating the
// on-screen reveal, checked here so the ROLE_CHANGE_PASSWORD value itself
// never has to ship to client JS.
//
// The Paid card's ₹ total is different: it's genuinely not computed until
// here. finalAmount isn't on the getTickets list Overview already fetched
// (see lib/myntra.js's fetchSpfPaidClaims) — it costs one extra Myntra call
// per paid ticket, so it only runs once the password is verified and only
// when `key === 'paid'`, not on every page load. The same call also splits
// that total into fake / wrong / etc. by matching each paid claim against
// stock-manager's return log (lib/spfPaid.js) — if stock-manager can't be
// read, the total still comes back, just with `breakdownError` set.
export async function POST(request) {
  const check = await requireOwner();
  if (!check.ok) return NextResponse.json({ error: check.error }, { status: check.status });

  const body = await request.json().catch(() => ({}));
  const ok = Boolean(process.env.ROLE_CHANGE_PASSWORD) && body.confirmPassword === process.env.ROLE_CHANGE_PASSWORD;
  if (!ok) return NextResponse.json({ error: 'Wrong confirmation password' }, { status: 403 });

  if (body.key !== 'paid') return NextResponse.json({ ok: true });

  const db = await getDb();
  const sessionDoc = await db.collection('settings').findOne({ _id: 'session' });
  if (!sessionDoc || !sessionDoc.headers) {
    return NextResponse.json({ error: 'No Myntra session saved — paste one on the admin page.' }, { status: 400 });
  }

  try {
    const paid = await fetchSpfPaidBreakdown(sessionDoc.headers);
    return NextResponse.json({ ok: true, ...paid });
  } catch (err) {
    const status = err.response && err.response.status;
    return NextResponse.json({ error: err.message }, { status: status === 401 || status === 403 ? 401 : 500 });
  }
}
