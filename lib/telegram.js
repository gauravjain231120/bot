const axios = require('axios');

// TELEGRAM_CHAT_ID supports a comma-separated list, so every alert reaches
// everyone who needs it (e.g. multiple family members' own Telegram accounts).
function getChatIds() {
  return (process.env.TELEGRAM_CHAT_ID || '')
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean);
}

// Sends to every configured chat independently — one recipient's chat going
// bad (e.g. they block the bot) must never stop the others from getting alerts.
async function sendToAll(path, payload) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatIds = getChatIds();
  if (!token || chatIds.length === 0) {
    console.error(`TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID missing — cannot send ${path}`);
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
  await sendToAll('sendMessage', { text, parse_mode: 'HTML' });
}

// Replies to exactly one chat — used for command responses (/ship, /make),
// which should answer only whoever asked, not broadcast to every recipient.
async function replyToChat(chatId, text) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token || !chatId) {
    console.error('TELEGRAM_BOT_TOKEN / chatId missing — cannot reply:', text);
    return;
  }
  await axios.post(`https://api.telegram.org/bot${token}/sendMessage`, {
    chat_id: chatId,
    text,
    parse_mode: 'HTML',
  });
}

async function sendTelegramPhoto(photoUrl, caption) {
  await sendToAll('sendPhoto', { photo: photoUrl, caption, parse_mode: 'HTML' });
}

// Sends several photos as one Telegram album (each with its own caption) so a
// multi-product order's items appear grouped together instead of as separate
// messages. Telegram requires 2+ items for sendMediaGroup; a single item should
// use sendTelegramPhoto instead.
async function sendTelegramMediaGroup(items) {
  await sendToAll('sendMediaGroup', {
    media: items.map(({ photo, caption }) => ({
      type: 'photo',
      media: photo,
      caption,
      parse_mode: 'HTML',
    })),
  });
}

module.exports = { sendTelegramMessage, sendTelegramPhoto, sendTelegramMediaGroup, replyToChat };
