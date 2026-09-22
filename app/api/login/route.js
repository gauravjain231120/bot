import { NextResponse } from 'next/server';
import { verifyPassword } from '../../../lib/accounts';
import { createSession, COOKIE_NAME, SESSION_TTL_MS } from '../../../lib/adminAuth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request) {
  const { username, password } = await request.json().catch(() => ({}));
  const account = await verifyPassword(username, password);
  if (!account) {
    return NextResponse.json({ error: 'Invalid username or password' }, { status: 401 });
  }

  const token = await createSession(account.username, account.role);
  const res = NextResponse.json({ ok: true, account });
  res.cookies.set(COOKIE_NAME, token, {
    httpOnly: true,
    secure: true,
    sameSite: 'lax',
    maxAge: SESSION_TTL_MS / 1000,
    path: '/',
  });
  return res;
}
