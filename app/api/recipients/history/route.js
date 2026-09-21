import { NextResponse } from 'next/server';
import { isAuthed } from '../../../../lib/adminAuth';
import { listRoleHistory } from '../../../../lib/recipients';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  if (!(await isAuthed())) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  const history = await listRoleHistory();
  return NextResponse.json({
    history: history.map((h) => ({
      chatId: h.chatId,
      name: h.name,
      fromRole: h.fromRole,
      toRole: h.toRole,
      changedAt: h.changedAt,
    })),
  });
}
