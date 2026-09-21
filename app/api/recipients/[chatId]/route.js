import { NextResponse } from 'next/server';
import { isAuthed } from '../../../../lib/adminAuth';
import { ROLES, setRole, deleteRecipient } from '../../../../lib/recipients';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function PATCH(request, ctx) {
  if (!(await isAuthed())) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  const { chatId } = await ctx.params;
  const body = await request.json().catch(() => ({}));
  if (!ROLES.includes(body.role)) {
    return NextResponse.json({ error: `role must be one of ${ROLES.join(', ')}` }, { status: 400 });
  }

  try {
    await setRole(chatId, body.role);
  } catch (err) {
    return NextResponse.json({ error: err.message }, { status: 404 });
  }
  return NextResponse.json({ ok: true });
}

export async function DELETE(request, ctx) {
  if (!(await isAuthed())) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  const { chatId } = await ctx.params;
  await deleteRecipient(chatId);
  return NextResponse.json({ ok: true });
}
