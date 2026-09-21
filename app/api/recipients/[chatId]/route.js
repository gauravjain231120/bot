import { NextResponse } from 'next/server';
import { isAuthed } from '../../../../lib/adminAuth';
import { ROLES, setRole, deleteRecipient } from '../../../../lib/recipients';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// A second, separate password on top of the dashboard login itself — role
// changes and removals affect who gets alerted about real orders/returns, so
// this is a deliberate extra confirmation step, checked server-side (never
// trust a client-side-only prompt for this).
function checkRolePassword(body) {
  return Boolean(process.env.ROLE_CHANGE_PASSWORD) && body.password === process.env.ROLE_CHANGE_PASSWORD;
}

export async function PATCH(request, ctx) {
  if (!(await isAuthed())) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  const { chatId } = await ctx.params;
  const body = await request.json().catch(() => ({}));

  if (!ROLES.includes(body.role)) {
    return NextResponse.json({ error: `role must be one of ${ROLES.join(', ')}` }, { status: 400 });
  }
  if (!checkRolePassword(body)) {
    return NextResponse.json({ error: 'Wrong password' }, { status: 403 });
  }

  try {
    await setRole(chatId, body.role);
  } catch (err) {
    const status = err.message === 'Recipient not found' ? 404 : err.message.includes('protected') ? 403 : 400;
    return NextResponse.json({ error: err.message }, { status });
  }
  return NextResponse.json({ ok: true });
}

export async function DELETE(request, ctx) {
  if (!(await isAuthed())) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  const { chatId } = await ctx.params;
  const body = await request.json().catch(() => ({}));

  if (!checkRolePassword(body)) {
    return NextResponse.json({ error: 'Wrong password' }, { status: 403 });
  }

  try {
    await deleteRecipient(chatId);
  } catch (err) {
    const status = err.message.includes('protected') ? 403 : 400;
    return NextResponse.json({ error: err.message }, { status });
  }
  return NextResponse.json({ ok: true });
}
