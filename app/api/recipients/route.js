import { NextResponse } from 'next/server';
import { isAuthed } from '../../../lib/adminAuth';
import { listRecipients } from '../../../lib/recipients';
import { getBotUsername } from '../../../lib/telegram';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  if (!(await isAuthed())) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  const [recipients, botUsername] = await Promise.all([listRecipients(), getBotUsername()]);

  return NextResponse.json({
    botUsername,
    recipients: recipients.map((r) => ({
      chatId: r._id,
      name: r.name || null,
      username: r.username || null,
      role: r.role,
      firstSeenAt: r.firstSeenAt || null,
      lastSeenAt: r.lastSeenAt || null,
    })),
  });
}
