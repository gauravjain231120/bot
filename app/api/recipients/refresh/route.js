import { NextResponse } from 'next/server';
import { isAuthed } from '../../../../lib/adminAuth';
import { listRecipients, updateProfile, toPublicShape } from '../../../../lib/recipients';
import { getChatInfo, getBotUsername } from '../../../../lib/telegram';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Live-pulls every (non-protected) recipient's current Telegram profile and
// overwrites name/username from it — so "Refresh" guarantees names are
// verifiably Telegram-sourced right now, not just whatever was captured the
// last time that person happened to message the bot.
export async function POST() {
  if (!(await isAuthed())) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  const recipients = await listRecipients();
  const visible = recipients.filter((r) => !r.protected);

  await Promise.all(
    visible.map(async (r) => {
      const info = await getChatInfo(r._id);
      if (info && info.name) {
        await updateProfile(r._id, info);
      }
    }),
  );

  const [fresh, botUsername] = await Promise.all([listRecipients(), getBotUsername()]);
  return NextResponse.json({
    botUsername,
    recipients: fresh.filter((r) => !r.protected).map(toPublicShape),
  });
}
