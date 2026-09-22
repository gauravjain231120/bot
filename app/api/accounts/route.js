import { NextResponse } from 'next/server';
import { requireOwner } from '../../../lib/adminAuth';
import { listAccounts, createAccount } from '../../../lib/accounts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const check = await requireOwner();
  if (!check.ok) return NextResponse.json({ error: check.error }, { status: check.status });
  return NextResponse.json({ accounts: await listAccounts() });
}

/** POST { username, password, role } -> add a new dashboard login. Owner only. */
export async function POST(request) {
  const check = await requireOwner();
  if (!check.ok) return NextResponse.json({ error: check.error }, { status: check.status });

  const body = await request.json().catch(() => ({}));
  try {
    const account = await createAccount(body.username, body.password, body.role || 'VIEWER');
    return NextResponse.json({ ok: true, account });
  } catch (err) {
    return NextResponse.json({ error: err.message }, { status: 400 });
  }
}
