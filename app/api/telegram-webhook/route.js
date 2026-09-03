import { NextResponse } from 'next/server';
import { replyToChat } from '../../../lib/telegram';
import { fetchQueueSummary, formatShipList, formatMakeList } from '../../../lib/telegramCommands';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Telegram calls this on every incoming message. Always ack quickly with 200
// (even for rejected/unrecognized messages) — a non-200 or slow response
// makes Telegram retry the same update repeatedly.
export async function POST(request) {
  const secret = request.headers.get('x-telegram-bot-api-secret-token');
  if (!process.env.TELEGRAM_WEBHOOK_SECRET || secret !== process.env.TELEGRAM_WEBHOOK_SECRET) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 403 });
  }

  const update = await request.json().catch(() => ({}));
  const message = update.message;
  const chatId = message && message.chat && String(message.chat.id);
  const text = (message && message.text) || '';

  // Command access is scoped to a single chat for now — everyone else's
  // messages (including the other alert recipients) are silently ignored,
  // never revealing that this bot understands commands at all.
  const allowedChatId = process.env.TELEGRAM_COMMAND_CHAT_ID;
  if (!chatId || !allowedChatId || chatId !== allowedChatId) {
    return NextResponse.json({ ok: true });
  }

  try {
    if (text.startsWith('/ship')) {
      const summary = await fetchQueueSummary();
      await replyToChat(chatId, formatShipList(summary));
    } else if (text.startsWith('/make')) {
      const summary = await fetchQueueSummary();
      await replyToChat(chatId, formatMakeList(summary));
    } else if (text.startsWith('/')) {
      await replyToChat(chatId, 'Unknown command. Try /ship (full queue) or /make (out of stock).');
    }
  } catch (err) {
    console.error('telegram-webhook command failed:', err.message);
    await replyToChat(chatId, `⚠️ Could not fetch that right now: ${err.message}`).catch(() => {});
  }

  return NextResponse.json({ ok: true });
}
