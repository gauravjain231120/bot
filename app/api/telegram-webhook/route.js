import { NextResponse } from 'next/server';
import { replyToChat, sendTelegramMessage } from '../../../lib/telegram';
import {
  fetchQueueSummary,
  formatShipList,
  formatMakeList,
  formatPlatformList,
  formatPlatformLeftList,
} from '../../../lib/telegramCommands';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const COMMAND_LIST =
  '<b>Commands</b>\n\n' +
  '/ship — Ready to Ship queue (just you)\n' +
  '/shipall — same, sent to everyone\n' +
  '/make — out-of-stock items (just you)\n' +
  '/makeall — same, sent to everyone\n' +
  '/myntra — Myntra queue only (just you)\n' +
  '/myntraall — same, sent to everyone\n' +
  '/myntraleft — Myntra items not yet packed (just you)\n' +
  '/myntraleftall — same, sent to everyone\n' +
  '/amazon — Amazon queue only (just you)\n' +
  '/amazonall — same, sent to everyone\n' +
  '/amazonleft — Amazon items not yet packed (just you)\n' +
  '/amazonleftall — same, sent to everyone\n' +
  '/command — this list';

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
    if (text.startsWith('/shipall')) {
      // Broadcasts to everyone (same recipients as order alerts) — checked
      // before /ship since it's the more specific match.
      const summary = await fetchQueueSummary();
      await sendTelegramMessage(formatShipList(summary));
    } else if (text.startsWith('/ship')) {
      const summary = await fetchQueueSummary();
      await replyToChat(chatId, formatShipList(summary));
    } else if (text.startsWith('/makeall')) {
      // Same idea — checked before /make since it's the more specific match.
      const summary = await fetchQueueSummary();
      await sendTelegramMessage(formatMakeList(summary));
    } else if (text.startsWith('/make')) {
      const summary = await fetchQueueSummary();
      await replyToChat(chatId, formatMakeList(summary));
    } else if (text.startsWith('/myntraleftall')) {
      // Most specific /myntra* variant — must be checked before /myntraall
      // and /myntra, since both of those are also true prefixes of this text.
      const summary = await fetchQueueSummary();
      await sendTelegramMessage(formatPlatformLeftList(summary, 'MYNTRA', 'Myntra'));
    } else if (text.startsWith('/myntraleft')) {
      const summary = await fetchQueueSummary();
      await replyToChat(chatId, formatPlatformLeftList(summary, 'MYNTRA', 'Myntra'));
    } else if (text.startsWith('/myntraall')) {
      const summary = await fetchQueueSummary();
      await sendTelegramMessage(formatPlatformList(summary, 'MYNTRA', 'Myntra'));
    } else if (text.startsWith('/myntra')) {
      const summary = await fetchQueueSummary();
      await replyToChat(chatId, formatPlatformList(summary, 'MYNTRA', 'Myntra'));
    } else if (text.startsWith('/amazonleftall')) {
      // Same ordering rule as /myntraleftall above.
      const summary = await fetchQueueSummary();
      await sendTelegramMessage(formatPlatformLeftList(summary, 'AMAZON', 'Amazon'));
    } else if (text.startsWith('/amazonleft')) {
      const summary = await fetchQueueSummary();
      await replyToChat(chatId, formatPlatformLeftList(summary, 'AMAZON', 'Amazon'));
    } else if (text.startsWith('/amazonall')) {
      const summary = await fetchQueueSummary();
      await sendTelegramMessage(formatPlatformList(summary, 'AMAZON', 'Amazon'));
    } else if (text.startsWith('/amazon')) {
      const summary = await fetchQueueSummary();
      await replyToChat(chatId, formatPlatformList(summary, 'AMAZON', 'Amazon'));
    } else if (text.startsWith('/command')) {
      await replyToChat(chatId, COMMAND_LIST);
    } else if (text.startsWith('/')) {
      await replyToChat(chatId, `Unknown command.\n\n${COMMAND_LIST}`);
    }
  } catch (err) {
    console.error('telegram-webhook command failed:', err.message);
    await replyToChat(chatId, `⚠️ Could not fetch that right now: ${err.message}`).catch(() => {});
  }

  return NextResponse.json({ ok: true });
}
