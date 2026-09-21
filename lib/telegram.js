const axios = require('axios');
const { chatIdsForRoles } = require('./recipients');

// Who gets what is now managed on the admin dashboard (Recipients section),
// backed by the `recipients` collection — not the old TELEGRAM_CHAT_ID /
// TELEGRAM_COMMAND_CHAT_ID env-var lists. Owner sees every alert (broadcast
// + owner-only); Viewer sees broadcast only (new orders, cancellations).
// TELEGRAM_COMMAND_CHAT_ID still exists, but only controls who can issue bot
// commands (/ship, /make, ...) — see app/api/telegram-webhook/route.js.
async function getBroadcastChatIds() {
  return chatIdsForRoles(['OWNER', 'VIEWER']);
}

async function getOwnerChatIds() {
  return chatIdsForRoles(['OWNER']);
}

// Sends to every chat in `chatIds` independently — one recipient's chat going
// bad (e.g. they block the bot) must never stop the others from getting alerts.
// Defaults to the broadcast list (Owner + Viewer); pass a single-chat array to
// reach just one, or an explicit list (e.g. Owner-only) for anything else.
async function sendToChats(path, payload, chatIds) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const ids = chatIds || (await getBroadcastChatIds());
  if (!token || ids.length === 0) {
    console.error(`TELEGRAM_BOT_TOKEN / no recipients for this alert — cannot send ${path}`);
    return;
  }
  const results = await Promise.allSettled(
    ids.map((chatId) => axios.post(`https://api.telegram.org/bot${token}/${path}`, { ...payload, chat_id: chatId }))
  );
  results.forEach((r, i) => {
    if (r.status === 'rejected') {
      console.error(`Telegram ${path} to ${ids[i]} failed:`, r.reason && r.reason.message);
    }
  });
}

async function sendTelegramMessage(text) {
  await sendToChats('sendMessage', { text, parse_mode: 'HTML' });
}

// Reaches only whoever has Owner role — session expiry, queue failures, the
// OTC pickup/return code, sync heartbeats, etc. Everyone else (Viewer role)
// never sees these, same separation the old TELEGRAM_COMMAND_CHAT_ID gave,
// just role-driven and no longer limited to a single hardcoded chat id.
async function sendOwnerAlert(text, opts = {}) {
  const ids = await getOwnerChatIds();
  await sendToChats('sendMessage', { text, parse_mode: 'HTML', disable_notification: !!opts.silent }, ids);
}

// Replies to exactly one chat — used for command responses (/ship, /make) and
// primary-only alerts, which should reach only that one chat, not broadcast to
// every recipient. Pass { silent: true } for a routine "FYI" that shouldn't
// buzz the phone — session-expired stays noisy by default since that one
// needs attention.
async function replyToChat(chatId, text, opts = {}) {
  if (!chatId) {
    console.error('chatId missing — cannot reply:', text);
    return;
  }
  await sendToChats('sendMessage', { text, parse_mode: 'HTML', disable_notification: !!opts.silent }, [chatId]);
}

async function sendTelegramPhoto(photoUrl, caption) {
  await sendToChats('sendPhoto', { photo: photoUrl, caption, parse_mode: 'HTML' });
}

async function replyPhotoToChat(chatId, photoUrl, caption) {
  if (!chatId) return;
  await sendToChats('sendPhoto', { photo: photoUrl, caption, parse_mode: 'HTML' }, [chatId]);
}

// Sends several photos as one Telegram album (each with its own caption) so a
// multi-product order's items appear grouped together instead of as separate
// messages. Telegram requires 2+ items for sendMediaGroup; a single item should
// use sendTelegramPhoto instead.
function mediaGroupPayload(items) {
  return {
    media: items.map(({ photo, caption }) => ({
      type: 'photo',
      media: photo,
      caption,
      parse_mode: 'HTML',
    })),
  };
}

async function sendTelegramMediaGroup(items) {
  await sendToChats('sendMediaGroup', mediaGroupPayload(items));
}

async function replyMediaGroupToChat(chatId, items) {
  if (!chatId) return;
  await sendToChats('sendMediaGroup', mediaGroupPayload(items), [chatId]);
}

// Cached for the life of the server process — the bot's own username never
// changes, so there's no reason to hit Telegram for it more than once. Used
// only for the dashboard's "message @thisbot to get added" hint.
async function getBotUsername() {
  if (global._botUsernameCache !== undefined) return global._botUsernameCache;
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) return null;
  try {
    const res = await axios.get(`https://api.telegram.org/bot${token}/getMe`);
    global._botUsernameCache = (res.data && res.data.result && res.data.result.username) || null;
  } catch (err) {
    console.error('getBotUsername failed:', err.message);
    global._botUsernameCache = null;
  }
  return global._botUsernameCache;
}

module.exports = {
  sendTelegramMessage,
  sendTelegramPhoto,
  sendTelegramMediaGroup,
  sendOwnerAlert,
  replyToChat,
  replyPhotoToChat,
  replyMediaGroupToChat,
  getBotUsername,
};
