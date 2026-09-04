import { NextResponse } from 'next/server';
import { replyToChat, sendTelegramMessage } from '../../../lib/telegram';
import {
  fetchQueueSummary,
  formatShipList,
  formatMakeList,
  formatPlatformList,
  formatPlatformLeftList,
  parseShortDate,
} from '../../../lib/telegramCommands';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const COMMAND_LIST =
  '<b>Commands</b>\n' +
  '(add a date like "5aug" or "10dec" to any queue command to filter it)\n\n' +
  '/ship [date] — Ready to Ship queue (just you)\n' +
  '/shipall [date] — same, sent to everyone\n' +
  '/make — out-of-stock items (just you)\n' +
  '/makeall — same, sent to everyone\n' +
  '/myntra [date] — Myntra queue only (just you)\n' +
  '/myntraall [date] — same, sent to everyone\n' +
  '/myntraleft [date] — Myntra items not yet packed (just you)\n' +
  '/myntraleftall [date] — same, sent to everyone\n' +
  '/amazon [date] — Amazon queue only (just you)\n' +
  '/amazonall [date] — same, sent to everyone\n' +
  '/amazonleft [date] — Amazon items not yet packed (just you)\n' +
  '/amazonleftall [date] — same, sent to everyone\n' +
  '/command — this list';

// Every command below that can take a trailing date argument.
const DATE_CAPABLE = new Set([
  '/ship',
  '/shipall',
  '/myntra',
  '/myntraall',
  '/amazon',
  '/amazonall',
  '/myntraleft',
  '/myntraleftall',
  '/amazonleft',
  '/amazonleftall',
]);

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
  const text = ((message && message.text) || '').trim();

  // Command access is scoped to a single chat for now — everyone else's
  // messages (including the other alert recipients) are silently ignored,
  // never revealing that this bot understands commands at all.
  const allowedChatId = process.env.TELEGRAM_COMMAND_CHAT_ID;
  if (!chatId || !allowedChatId || chatId !== allowedChatId) {
    return NextResponse.json({ ok: true });
  }

  // Split "/ship 5aug" into command "/ship" and the rest as a date argument —
  // splitting on whitespace up front avoids the old startsWith-prefix chain,
  // where e.g. "/myntraleft" also matched as a prefix of checking "/myntra".
  const [rawCommand, ...rest] = text.split(/\s+/);
  const command = (rawCommand || '').toLowerCase();
  const dateArg = rest.join(' ');

  try {
    let dateFilter = null;
    if (DATE_CAPABLE.has(command) && dateArg) {
      dateFilter = parseShortDate(dateArg);
      if (!dateFilter) {
        await replyToChat(chatId, `Couldn't understand the date "${dateArg}". Try formats like 5aug, 6aug, 8nov, 10dec.`);
        return NextResponse.json({ ok: true });
      }
    }

    switch (command) {
      case '/shipall': {
        const summary = await fetchQueueSummary();
        await sendTelegramMessage(formatShipList(summary, dateFilter));
        break;
      }
      case '/ship': {
        const summary = await fetchQueueSummary();
        await replyToChat(chatId, formatShipList(summary, dateFilter));
        break;
      }
      case '/myntraleftall': {
        const summary = await fetchQueueSummary();
        await sendTelegramMessage(formatPlatformLeftList(summary, 'MYNTRA', 'Myntra', dateFilter));
        break;
      }
      case '/myntraleft': {
        const summary = await fetchQueueSummary();
        await replyToChat(chatId, formatPlatformLeftList(summary, 'MYNTRA', 'Myntra', dateFilter));
        break;
      }
      case '/myntraall': {
        const summary = await fetchQueueSummary();
        await sendTelegramMessage(formatPlatformList(summary, 'MYNTRA', 'Myntra', dateFilter));
        break;
      }
      case '/myntra': {
        const summary = await fetchQueueSummary();
        await replyToChat(chatId, formatPlatformList(summary, 'MYNTRA', 'Myntra', dateFilter));
        break;
      }
      case '/amazonleftall': {
        const summary = await fetchQueueSummary();
        await sendTelegramMessage(formatPlatformLeftList(summary, 'AMAZON', 'Amazon', dateFilter));
        break;
      }
      case '/amazonleft': {
        const summary = await fetchQueueSummary();
        await replyToChat(chatId, formatPlatformLeftList(summary, 'AMAZON', 'Amazon', dateFilter));
        break;
      }
      case '/amazonall': {
        const summary = await fetchQueueSummary();
        await sendTelegramMessage(formatPlatformList(summary, 'AMAZON', 'Amazon', dateFilter));
        break;
      }
      case '/amazon': {
        const summary = await fetchQueueSummary();
        await replyToChat(chatId, formatPlatformList(summary, 'AMAZON', 'Amazon', dateFilter));
        break;
      }
      case '/makeall': {
        const summary = await fetchQueueSummary();
        await sendTelegramMessage(formatMakeList(summary));
        break;
      }
      case '/make': {
        const summary = await fetchQueueSummary();
        await replyToChat(chatId, formatMakeList(summary));
        break;
      }
      case '/command': {
        await replyToChat(chatId, COMMAND_LIST);
        break;
      }
      default: {
        if (command.startsWith('/')) {
          await replyToChat(chatId, `Unknown command.\n\n${COMMAND_LIST}`);
        }
      }
    }
  } catch (err) {
    console.error('telegram-webhook command failed:', err.message);
    await replyToChat(chatId, `⚠️ Could not fetch that right now: ${err.message}`).catch(() => {});
  }

  return NextResponse.json({ ok: true });
}
