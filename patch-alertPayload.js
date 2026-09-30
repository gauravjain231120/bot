const fs = require('fs');
let code = fs.readFileSync('lib/alertPayload.js', 'utf8');

const target = `async function sendPayload({ text, photos = [] }, marketplace = null) {
  if (photos.length === 0) return sendTelegramMessage(text);
  const shown = await badgePhotos(photos.slice(0, MAX_ALBUM_PHOTOS), marketplace);
  if (shown.length === 1) return sendTelegramPhoto(shown[0], text);
  return sendTelegramMediaGroup(shown.map((photo, i) => ({ photo, caption: i === 0 ? text : undefined })));
}`;

const rep = `async function sendPayload({ text, photos = [], engineMode }, marketplace = null) {
  if (photos.length === 0) return sendTelegramMessage(text, engineMode);
  const shown = await badgePhotos(photos.slice(0, MAX_ALBUM_PHOTOS), marketplace);
  if (shown.length === 1) return sendTelegramPhoto(shown[0], text, engineMode);
  return sendTelegramMediaGroup(shown.map((photo, i) => ({ photo, caption: i === 0 ? text : undefined })), engineMode);
}`;

code = code.replace(target, rep);

fs.writeFileSync('lib/alertPayload.js', code);
