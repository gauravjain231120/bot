const axios = require('axios');

// TELEGRAM_CHAT_ID supports a comma-separated list, so every alert reaches
// everyone who needs it (e.g. multiple family members' own Telegram accounts).
function getChatIds() {
  return (process.env.TELEGRAM_CHAT_ID || '')
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean);
}

// Sends to every chat in `chatIds` independently — one recipient's chat going
// bad (e.g. they block the bot) must never stop the others from getting alerts.
// Defaults to the full broadcast list; pass a single-chat array to reach just one.
async function sendToChats(path, payload, chatIds = getChatIds()) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token || chatIds.length === 0) {
    console.error(`TELEGRAM_BOT_TOKEN / chat id missing — cannot send ${path}`);
    return;
  }
  const results = await Promise.allSettled(
    chatIds.map((chatId) => axios.post(`https://api.telegram.org/bot${token}/${path}`, { ...payload, chat_id: chatId }))
  );
  results.forEach((r, i) => {
    if (r.status === 'rejected') {
      console.error(`Telegram ${path} to ${chatIds[i]} failed:`, r.reason && r.reason.message);
    }
  });
}

async function sendTelegramMessage(text) {
  await sendToChats('sendMessage', { text, parse_mode: 'HTML' });
}

// Replies to exactly one chat — used for command responses (/ship, /make) and
// primary-only alerts (session expiry, order-add failures), which should reach
// only that one chat, not broadcast to every recipient. Pass { silent: true }
// for a routine "FYI" that shouldn't buzz the phone — session-expired stays
// noisy by default since that one needs attention.
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

module.exports = {
  sendTelegramMessage,
  sendTelegramPhoto,
  sendTelegramMediaGroup,
  replyToChat,
  replyPhotoToChat,
  replyMediaGroupToChat,
};
