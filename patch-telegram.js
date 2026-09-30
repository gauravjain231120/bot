const fs = require('fs');
let code = fs.readFileSync('lib/telegram.js', 'utf8');

const targetSendToChats = `async function sendToChats(path, payload, chatIds) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const ids = chatIds || (await getBroadcastChatIds());
  if (!token || ids.length === 0) {
    console.error(\`TELEGRAM_BOT_TOKEN / no recipients for this alert — cannot send \${path}\`);
    return { sent: 0, failed: 0, total: 0 };
  }
  const results = await Promise.allSettled(ids.map((chatId) => postToChat(token, path, payload, chatId)));`;

const repSendToChats = `async function sendToChats(path, payload, chatIds, engineMode) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const ids = chatIds || (await getBroadcastChatIds());
  if (!token || ids.length === 0) {
    console.error(\`TELEGRAM_BOT_TOKEN / no recipients for this alert — cannot send \${path}\`);
    return { sent: 0, failed: 0, total: 0 };
  }
  
  let ownerIds = [];
  if (engineMode) {
     ownerIds = await getOwnerChatIds();
  }

  const results = await Promise.allSettled(ids.map((chatId) => {
    let chatPayload = payload;
    if (engineMode && ownerIds.includes(chatId)) {
      const tag = \`\\n\\n[<i>\${engineMode === 'local' ? '💻' : '☁️'} Fetched via \${engineMode === 'local' ? 'Local' : 'Cloud'} Engine</i>]\`;
      chatPayload = { ...payload };
      if (path === 'sendMessage') {
         chatPayload.text = (chatPayload.text || '') + tag;
      } else if (path === 'sendPhoto') {
         chatPayload.caption = (chatPayload.caption || '') + tag;
      } else if (path === 'sendMediaGroup' && chatPayload.media) {
         try {
           const mediaArray = JSON.parse(chatPayload.media);
           if (mediaArray.length > 0) {
             mediaArray[0].caption = (mediaArray[0].caption || '') + tag;
           }
           chatPayload.media = JSON.stringify(mediaArray);
         } catch(e) {}
      }
    }
    return postToChat(token, path, chatPayload, chatId);
  }));`;

code = code.replace(targetSendToChats, repSendToChats);

const msgTarget = `async function sendTelegramMessage(text) {
  return sendToChats('sendMessage', { text, parse_mode: 'HTML' });
}`;
const msgRep = `async function sendTelegramMessage(text, engineMode) {
  return sendToChats('sendMessage', { text, parse_mode: 'HTML' }, null, engineMode);
}`;
code = code.replace(msgTarget, msgRep);

const photoTarget = `async function sendTelegramPhoto(photo, caption) {
  return sendToChats('sendPhoto', { photo, caption, parse_mode: 'HTML' });
}`;
const photoRep = `async function sendTelegramPhoto(photo, caption, engineMode) {
  return sendToChats('sendPhoto', { photo, caption, parse_mode: 'HTML' }, null, engineMode);
}`;
code = code.replace(photoTarget, photoRep);

const mediaTarget = `async function sendTelegramMediaGroup(items) {
  return sendToChats('sendMediaGroup', mediaGroupPayload(items));
}`;
const mediaRep = `async function sendTelegramMediaGroup(items, engineMode) {
  return sendToChats('sendMediaGroup', mediaGroupPayload(items), null, engineMode);
}`;
code = code.replace(mediaTarget, mediaRep);

fs.writeFileSync('lib/telegram.js', code);
