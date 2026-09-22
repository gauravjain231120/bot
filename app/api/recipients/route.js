import { NextResponse } from 'next/server';
import { requireOwner } from '../../../lib/adminAuth';
import { listRecipients, toPublicShape } from '../../../lib/recipients';
import { getBotUsername } from '../../../lib/telegram';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const check = await requireOwner();
  if (!check.ok) return NextResponse.json({ error: check.error }, { status: check.status });

  const [recipients, botUsername] = await Promise.all([listRecipients(), getBotUsername()]);

  // The protected founding-Owner row is deliberately left off this list —
  // always Owner, always able to issue commands and receive every alert,
  // never editable or even visible from here, so there's no way to demote
  // or remove yourself through this UI and lock everyone out.
  return NextResponse.json({
    botUsername,
    recipients: recipients.filter((r) => !r.protected).map(toPublicShape),
  });
}
