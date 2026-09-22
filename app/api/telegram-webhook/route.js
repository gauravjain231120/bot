import { NextResponse } from 'next/server';
import { getDb } from '../../../lib/db';
import { replyToChat, sendTelegramMessage } from '../../../lib/telegram';
import { recordSeen } from '../../../lib/recipients';
import { fetchPackedCount } from '../../../lib/myntra';
import {
  fetchQueueSummary,
  formatShipList,
  formatMakeList,
  formatPlatformList,
  formatPlatformLeftList,
  formatReadyList,
  formatNotReadyList,
  formatPackedCount,
  parseShortDate,
  toDMY,
  todayIst,
} from '../../../lib/telegramCommands';

// Same saved Myntra session the cron checks use — read fresh per command
// rather than cached, so a just-refreshed session takes effect immediately.
async function getMyntraHeaders() {
  const db = await getDb();
  const sessionDoc = await db.collection('settings').findOne({ _id: 'session' });
  if (!sessionDoc || !sessionDoc.headers) {
    throw new Error('No Myntra session saved — paste one on the admin page.');
  }
  return sessionDoc.headers;
}

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
  '/ready [date] — everything packed & waiting to ship, all platforms (just you)\n' +
  '/readyall [date] — same, sent to everyone\n' +
  '/notready [date] — everything still left to pack, all platforms (just you)\n' +
  '/notreadyall [date] — same, sent to everyone\n' +
  '/packed [date] — Myntra packed-order count, today unless a date is given (just you)\n' +
  '/packedall [date] — same, sent to everyone\n' +
  '/command — this list';

// A brand-new chat id (never before recorded) gets this once, right after
// recordSeen() — turns "message the bot" into the entire onboarding step for
// a would-be recipient, no chat-id-hunting required on either side.
const WELCOME_TEXT =
  "👋 Got it — I've noted your chat ID. Ask Gaurav to activate your alerts on the dashboard.";

function nameFromMessage(message) {
  const from = (message && message.from) || (message && message.chat) || {};
  const name = [from.first_name, from.last_name].filter(Boolean).join(' ').trim() || from.username || 'Unknown';
  return { name, username: from.username || null };
}

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
  '/ready',
  '/readyall',
  '/notready',
  '/notreadyall',
  '/packed',
  '/packedall',
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

  // Every sender gets recorded (not just an Owner) — this is how a new
  // Owner/Viewer candidate shows up on the dashboard's Recipients list at
  // all, before anyone has assigned them a role. Never blocks the rest of
  // the handler — a DB hiccup here must not break existing bot commands.
  // recordSeen() also hands back this chat's current role, so command
  // gating below costs no extra DB round-trip.
  let isOwner = false;
  if (chatId) {
    try {
      const { isNew, role } = await recordSeen(chatId, nameFromMessage(message));
      isOwner = role === 'OWNER';
      if (isNew) {
        await replyToChat(chatId, WELCOME_TEXT).catch(() => {});
      }
    } catch (err) {
      console.error('recordSeen failed:', err.message);
    }
  }

  // Command access now follows Owner role from the Recipients list, not a
  // fixed env var — anyone promoted to Owner can issue /ship, /make, etc,
  // and anyone demoted loses that ability immediately, no redeploy. Everyone
  // else's messages are silently ignored from here on, never revealing that
  // this bot understands commands at all.
  if (!chatId || !isOwner) {
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
      case '/readyall': {
        const summary = await fetchQueueSummary();
        await sendTelegramMessage(formatReadyList(summary, dateFilter));
        break;
      }
      case '/ready': {
        const summary = await fetchQueueSummary();
        await replyToChat(chatId, formatReadyList(summary, dateFilter));
        break;
      }
      case '/notreadyall': {
        const summary = await fetchQueueSummary();
        await sendTelegramMessage(formatNotReadyList(summary, dateFilter));
        break;
      }
      case '/notready': {
        const summary = await fetchQueueSummary();
        await replyToChat(chatId, formatNotReadyList(summary, dateFilter));
        break;
      }
      case '/packedall': {
        const dayKey = dateFilter || todayIst();
        const dmy = toDMY(dayKey);
        const headers = await getMyntraHeaders();
        const count = await fetchPackedCount(dmy, dmy, headers);
        await sendTelegramMessage(formatPackedCount(count, dayKey));
        break;
      }
      case '/packed': {
        const dayKey = dateFilter || todayIst();
        const dmy = toDMY(dayKey);
        const headers = await getMyntraHeaders();
        const count = await fetchPackedCount(dmy, dmy, headers);
        await replyToChat(chatId, formatPackedCount(count, dayKey));
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
