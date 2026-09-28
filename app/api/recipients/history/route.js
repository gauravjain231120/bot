import { NextResponse } from 'next/server';
import { listRoleHistory } from '../../../../lib/recipients';
import { requireSection } from '../../../../lib/access';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const check = await requireSection('recipients');
  if (!check.ok) return NextResponse.json({ error: check.error }, { status: check.status });

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
