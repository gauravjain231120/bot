const axios = require('axios');

async function sendTelegramMessage(text) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) {
    console.error('TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID missing — cannot send alert:', text);
    return;
  }
  await axios.post(`https://api.telegram.org/bot${token}/sendMessage`, {
    chat_id: chatId,
    text,
    parse_mode: 'HTML',
  });
}

async function sendTelegramPhoto(photoUrl, caption) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) {
    console.error('TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID missing — cannot send photo alert:', caption);
    return;
  }
  await axios.post(`https://api.telegram.org/bot${token}/sendPhoto`, {
    chat_id: chatId,
    photo: photoUrl,
    caption,
    parse_mode: 'HTML',
  });
}

// Sends several photos as one Telegram album (each with its own caption) so a
// multi-product order's items appear grouped together instead of as separate
// messages. Telegram requires 2+ items for sendMediaGroup; a single item should
// use sendTelegramPhoto instead.
async function sendTelegramMediaGroup(items) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) {
    console.error('TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID missing — cannot send media group');
    return;
  }
  await axios.post(`https://api.telegram.org/bot${token}/sendMediaGroup`, {
    chat_id: chatId,
    media: items.map(({ photo, caption }) => ({
      type: 'photo',
      media: photo,
      caption,
      parse_mode: 'HTML',
    })),
  });
}

module.exports = { sendTelegramMessage, sendTelegramPhoto, sendTelegramMediaGroup };
