const axios = require('axios');
const { chatIdsForRoles } = require('./recipients');
const { stripHtml } = require('./html');

// A Telegram call that hangs must not hold a cron run until the platform
// kills it. Photos get longer: Telegram downloads each image itself before it
// answers, and a send that times out on our side may still arrive — retried,
// that was a duplicate album.
const TELEGRAM_TIMEOUT_MS = 15000;
const TELEGRAM_MEDIA_TIMEOUT_MS = 35000;

// Telegram rejected the message's HTML ("can't parse entities") — the same
// payload as plain text, so the alert still arrives.
function plainPayload(payload) {
  const out = { ...payload };
  delete out.parse_mode;
  if (out.text != null) out.text = stripHtml(out.text);
  if (out.caption != null) out.caption = stripHtml(out.caption);
  if (Array.isArray(out.media)) {
    out.media = out.media.map((m) => {
      const x = { ...m };
      delete x.parse_mode;
      if (x.caption != null) x.caption = stripHtml(x.caption);
      return x;
    });
  }
  return out;
}

function isParseError(err) {
  const r = err && err.response;
  return !!(r && r.status === 400 && /parse entities|can't find end|unsupported start tag/i.test(String((r.data && r.data.description) || '')));
}

// Telegram limits: 1024 characters of (visible) caption, 4096 of message
// text, 10 photos per album.
const CAPTION_MAX = 1024;
const TEXT_MAX = 4096;
const ALBUM_MAX = 10;
const RATE_LIMIT_MAX_WAIT_S = 20;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const visibleLength = (html) => stripHtml(String(html || '')).length;

// A long text split at line breaks into messages Telegram accepts (lines
// carry their own tags, so a split never cuts one open).
function splitText(text) {
  const parts = [];
  let cur = '';
  for (const line of String(text || '').split('\n')) {
    const next = cur ? `${cur}\n${line}` : line;
    if (next.length > TEXT_MAX - 96 && cur) {
      parts.push(cur);
      cur = line.slice(0, TEXT_MAX - 96);
    } else {
      cur = next.slice(0, TEXT_MAX - 96);
    }
  }
  if (cur) parts.push(cur);
  return parts;
}

// The alert's text when its photo(s) can't go out: a photo URL Telegram can't
// fetch, a caption over the limit, an album Telegram refuses. Losing the
// picture is fine — losing the order alert is not.
function captionOf(path, payload) {
  if (path === 'sendPhoto') return payload.caption || '';
  if (path === 'sendMediaGroup') return (payload.media || []).map((m) => m.caption).filter(Boolean).join('\n\n');
  return '';
}

// A photo is its URL, or { file: <JPEG Buffer>, url } — the photo with the
// marketplace logo drawn on (lib/photoBadge.js), uploaded instead; `url` is
// what goes if Telegram refuses the upload.
const isUpload = (p) => !!(p && typeof p === 'object' && Buffer.isBuffer(p.file));
const hasUploads = (body) => isUpload(body.photo) || (Array.isArray(body.media) && body.media.some((m) => isUpload(m.media)));

function withPhotoUrls(body) {
  const out = { ...body };
  if (isUpload(out.photo)) out.photo = out.photo.url;
  if (Array.isArray(out.media)) out.media = out.media.map((m) => (isUpload(m.media) ? { ...m, media: m.media.url } : m));
  return out;
}

// Uploads go as multipart: the file itself for sendPhoto, `attach://pN` in an
// album's media list with the file alongside.
function formOf(body) {
  const form = new FormData();
  const jpeg = (file) => new Blob([file], { type: 'image/jpeg' });
  for (const [key, value] of Object.entries(body)) {
    if (value === undefined || value === null) continue;
    if (key === 'photo' && isUpload(value)) {
      form.append('photo', jpeg(value.file), 'photo.jpg');
    } else if (key === 'media' && Array.isArray(value)) {
      const media = value.map((m, i) => {
        if (!isUpload(m.media)) return m;
        form.append(`p${i}`, jpeg(m.media.file), `p${i}.jpg`);
        return { ...m, media: `attach://p${i}` };
      });
      form.append('media', JSON.stringify(media));
    } else {
      form.append(key, String(value));
    }
  }
  return form;
}

async function post(url, body) {
  const media = /\/(sendPhoto|sendMediaGroup)$/.test(url);
  return axios.post(url, hasUploads(body) ? formOf(body) : body, { timeout: media ? TELEGRAM_MEDIA_TIMEOUT_MS : TELEGRAM_TIMEOUT_MS });
}

async function postToChat(token, path, payload, chatId) {
  const base = `https://api.telegram.org/bot${token}`;
  const send = async (p, body) => {
    try {
      return await post(`${base}/${p}`, { ...body, chat_id: chatId });
    } catch (err) {
      const r = err && err.response;
      // Rate limited (a burst after an outage / Start): wait as told, once.
      const wait = r && r.status === 429 && r.data && r.data.parameters && Number(r.data.parameters.retry_after);
      if (wait && wait <= RATE_LIMIT_MAX_WAIT_S) {
        await sleep(wait * 1000 + 250);
        return post(`${base}/${p}`, { ...body, chat_id: chatId });
      }
      if (!isParseError(err)) throw err;
      console.error(`Telegram ${p} to ${chatId}: HTML rejected (${r.data.description}) — resending as plain text`);
      return post(`${base}/${p}`, { ...plainPayload(body), chat_id: chatId });
    }
  };
  const sendText = async (text, extra) => {
    let last;
    for (const part of splitText(text)) last = await send('sendMessage', { ...extra, text: part, parse_mode: 'HTML' });
    return last;
  };
  const extra = payload.disable_notification ? { disable_notification: true } : {};

  if (path === 'sendMessage') {
    if (String(payload.text || '').length <= TEXT_MAX) return send(path, payload);
    return sendText(payload.text, extra);
  }
  if (path === 'sendPhoto' || path === 'sendMediaGroup') {
    const caption = captionOf(path, payload);
    const tooLong = visibleLength(caption) > CAPTION_MAX;
    // Over the caption limit: the photo(s) without a caption, then the full
    // text as a message right after.
    const body = tooLong ? stripCaptions(path, payload) : payload;
    // A refused upload (the photo with the logo) goes again as plain photo
    // URLs, as before the logo — then, if those are refused too, the text.
    const sendPhotos = async () => {
      try {
        return await send(path, body);
      } catch (err) {
        const r = err && err.response;
        if (!hasUploads(body) || !r || r.status >= 500 || r.status === 403) throw err;
        console.error(`Telegram ${path} to ${chatId}: upload refused (${(r.data && r.data.description) || r.status}) — sending the photo links instead`);
        return send(path, withPhotoUrls(body));
      }
    };
    let res;
    try {
      res = await sendPhotos();
    } catch (err) {
      const r = err && err.response;
      if (!caption || !r || r.status >= 500 || r.status === 403) throw err; // chat blocked / Telegram down: text wouldn't help
      console.error(`Telegram ${path} to ${chatId} refused (${(r.data && r.data.description) || r.status}) — sending the text without photos`);
      return sendText(caption, extra);
    }
    if (tooLong && caption) {
      // The photos are there; a hiccup on the text is retried once on its own
      // rather than sending the photos all over again.
      try {
        await sendText(caption, extra);
      } catch (err) {
        await sleep(1500);
        await sendText(caption, extra);
      }
    }
    return res;
  }
  return send(path, payload);
}

function stripCaptions(path, payload) {
  if (path === 'sendPhoto') {
    const out = { ...payload };
    delete out.caption;
    delete out.parse_mode;
    return out;
  }
  return { ...payload, media: (payload.media || []).map(({ caption, parse_mode, ...m }) => m) };
}

// Who gets what is now fully managed on the admin dashboard (Recipients
// section), backed by the `recipients` collection — the old TELEGRAM_CHAT_ID
// / TELEGRAM_COMMAND_CHAT_ID env vars are no longer read anywhere in this
// codebase (bot command access, e.g. /ship, /make, is also role-driven now —
// see app/api/telegram-webhook/route.js). Owner sees every alert (broadcast
// + owner-only) and can issue commands; Viewer sees broadcast only (new
// orders, cancellations) and cannot issue commands.
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
//
// Returns { sent, failed, total } so a caller can tell "delivered" from
// "nobody got it" — anything that marks an alert as done (an order alerted,
// a once-per-outage flag) must only do so when sent > 0.
async function sendToChats(path, payload, chatIds) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const ids = chatIds || (await getBroadcastChatIds());
  if (!token || ids.length === 0) {
    console.error(`TELEGRAM_BOT_TOKEN / no recipients for this alert — cannot send ${path}`);
    return { sent: 0, failed: 0, total: 0 };
  }
  const results = await Promise.allSettled(ids.map((chatId) => postToChat(token, path, payload, chatId)));
  let sent = 0;
  results.forEach((r, i) => {
    if (r.status === 'rejected') {
      const d = r.reason && r.reason.response && r.reason.response.data;
      console.error(`Telegram ${path} to ${ids[i]} failed:`, (d && d.description) || (r.reason && r.reason.message));
    } else {
      sent++;
    }
  });
  return { sent, failed: ids.length - sent, total: ids.length };
}

async function sendTelegramMessage(text) {
  return sendToChats('sendMessage', { text, parse_mode: 'HTML' });
}

// Reaches only whoever has Owner role — session expiry, queue failures, the
// OTC pickup/return code, sync heartbeats, etc. Everyone else (Viewer role)
// never sees these, same separation the old TELEGRAM_COMMAND_CHAT_ID gave,
// just role-driven and no longer limited to a single hardcoded chat id.
async function sendOwnerAlert(text, opts = {}) {
  const ids = await getOwnerChatIds();
  return sendToChats('sendMessage', { text, parse_mode: 'HTML', disable_notification: !!opts.silent }, ids);
}

// Replies to exactly one chat — used for command responses (/ship, /make) and
// primary-only alerts, which should reach only that one chat, not broadcast to
// every recipient. Pass { silent: true } for a routine "FYI" that shouldn't
// buzz the phone — session-expired stays noisy by default since that one
// needs attention.
async function replyToChat(chatId, text, opts = {}) {
  if (!chatId) {
    console.error('chatId missing — cannot reply:', text);
    return { sent: 0, failed: 0, total: 0 };
  }
  return sendToChats('sendMessage', { text, parse_mode: 'HTML', disable_notification: !!opts.silent }, [chatId]);
}

// `photo`: a URL, or an upload (see isUpload above).
async function sendTelegramPhoto(photo, caption) {
  return sendToChats('sendPhoto', { photo, caption, parse_mode: 'HTML' });
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
    // Telegram refuses an album of more than 10 — the first 10 go.
    media: items.slice(0, ALBUM_MAX).map(({ photo, caption }) => ({
      type: 'photo',
      media: photo,
      caption,
      parse_mode: 'HTML',
    })),
  };
}

async function sendTelegramMediaGroup(items) {
  return sendToChats('sendMediaGroup', mediaGroupPayload(items));
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
    const res = await axios.get(`https://api.telegram.org/bot${token}/getMe`, { timeout: TELEGRAM_TIMEOUT_MS });
    global._botUsernameCache = (res.data && res.data.result && res.data.result.username) || null;
  } catch (err) {
    console.error('getBotUsername failed:', err.message);
    global._botUsernameCache = null;
  }
  return global._botUsernameCache;
}

// Live-pulls a chat's current Telegram profile (first/last name, username) —
// works any time after the bot has ever exchanged messages with that chat,
// not just right after a fresh incoming message. Backs the dashboard's
// "Refresh" button, so recipient names stay verifiably Telegram-sourced even
// for someone who hasn't messaged in a while, not just passively updated the
// next time they happen to send something.
async function getChatInfo(chatId) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) return null;
  try {
    const res = await axios.get(`https://api.telegram.org/bot${token}/getChat`, { params: { chat_id: chatId }, timeout: TELEGRAM_TIMEOUT_MS });
    const chat = res.data && res.data.result;
    if (!chat) return null;
    const name = [chat.first_name, chat.last_name].filter(Boolean).join(' ').trim() || chat.username || null;
    return { name, username: chat.username || null };
  } catch (err) {
    console.error(`getChatInfo(${chatId}) failed:`, err.message);
    return null;
  }
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
  getChatInfo,
};
