import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { destroySession, COOKIE_NAME } from '../../../lib/adminAuth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST() {
  const jar = await cookies();
  const token = jar.get(COOKIE_NAME)?.value;
  await destroySession(token);
  const res = NextResponse.json({ ok: true });
  res.cookies.delete(COOKIE_NAME);
  return res;
}
