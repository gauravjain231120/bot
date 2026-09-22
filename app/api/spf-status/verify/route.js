import { NextResponse } from 'next/server';
import { requireOwner } from '../../../../lib/adminAuth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// The SPF Status page already loads every count (including paidTotalAmount)
// client-side as soon as an Owner opens it — this route isn't a data
// boundary, the numbers are already in the page's own state by the time
// someone clicks a stat card. It's the same "second, separate password on
// top of the dashboard login itself" friction used for Team/Recipients
// (app/api/accounts/route.js's checkConfirmPassword) — just gating the
// on-screen reveal, checked here so the ROLE_CHANGE_PASSWORD value itself
// never has to ship to client JS.
export async function POST(request) {
  const check = await requireOwner();
  if (!check.ok) return NextResponse.json({ error: check.error }, { status: check.status });

  const body = await request.json().catch(() => ({}));
  const ok = Boolean(process.env.ROLE_CHANGE_PASSWORD) && body.confirmPassword === process.env.ROLE_CHANGE_PASSWORD;
  if (!ok) return NextResponse.json({ error: 'Wrong confirmation password' }, { status: 403 });

  return NextResponse.json({ ok: true });
}
