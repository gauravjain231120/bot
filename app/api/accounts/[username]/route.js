import { NextResponse } from 'next/server';
import { requireOwner } from '../../../../lib/adminAuth';
import { deleteAccount } from '../../../../lib/accounts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function DELETE(request, { params }) {
  const check = await requireOwner();
  if (!check.ok) return NextResponse.json({ error: check.error }, { status: check.status });

  const { username } = await params;
  try {
    await deleteAccount(username);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json({ error: err.message }, { status: 400 });
  }
}
