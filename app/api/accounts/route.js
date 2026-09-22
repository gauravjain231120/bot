import { NextResponse } from 'next/server';
import { requireOwner } from '../../../lib/adminAuth';
import { listAccounts, createAccount } from '../../../lib/accounts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// A second, separate password on top of the dashboard login itself — adding
// a new account affects who can log into this dashboard at all, so this is
// a deliberate extra confirmation step, checked server-side (never trust a
// client-side-only prompt for this). Same ROLE_CHANGE_PASSWORD env var and
// pattern already used for Telegram recipient role changes/removals
// (app/api/recipients/[chatId]/route.js) — one shared confirmation password
// for "this changes who has access", not a second one to remember.
function checkConfirmPassword(body) {
  return Boolean(process.env.ROLE_CHANGE_PASSWORD) && body.confirmPassword === process.env.ROLE_CHANGE_PASSWORD;
}

export async function GET() {
  const check = await requireOwner();
  if (!check.ok) return NextResponse.json({ error: check.error }, { status: check.status });
  return NextResponse.json({ accounts: await listAccounts() });
}

/** POST { username, password, role, confirmPassword } -> add a new dashboard login. Owner only. */
export async function POST(request) {
  const check = await requireOwner();
  if (!check.ok) return NextResponse.json({ error: check.error }, { status: check.status });

  const body = await request.json().catch(() => ({}));
  if (!checkConfirmPassword(body)) {
    return NextResponse.json({ error: 'Wrong confirmation password' }, { status: 403 });
  }

  try {
    const account = await createAccount(body.username, body.password, body.role || 'VIEWER');
    return NextResponse.json({ ok: true, account });
  } catch (err) {
    return NextResponse.json({ error: err.message }, { status: 400 });
  }
}
