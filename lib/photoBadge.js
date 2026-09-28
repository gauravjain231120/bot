const fs = require('fs');
const path = require('path');
const axios = require('axios');

// The marketplace's logo on the top-left corner of an alert photo, so a
// glance at the chat tells a Myntra order from an Amazon one. Best effort: a
// photo that can't be fetched or drawn goes out as before, by its URL
// (Telegram fetches it itself) — the logo is a nicety, the alert is not.
//
// badgePhotos(urls, marketplace) returns the photos in the same order, each
// either the URL as given or { file: <JPEG Buffer>, url } — uploaded by
// lib/telegram.js, which falls back to `url` if Telegram refuses the upload.

// lib/assets/*.png — traced into every API route (next.config.mjs).
const LOGO_FILES = { myntra: 'myntra-logo.png', amazon: 'amazon-logo.png' };
const FETCH_TIMEOUT_MS = 6000;
const MAX_PHOTO_BYTES = 10 * 1024 * 1024;
// Telegram never shows a photo bigger than this anyway.
const MAX_SIDE = 1280;

const logos = {};
function logoFor(marketplace) {
  const file = LOGO_FILES[marketplace];
  if (!file) return null;
  if (!(marketplace in logos)) {
    try {
      logos[marketplace] = fs.readFileSync(path.join(process.cwd(), 'lib', 'assets', file));
    } catch (err) {
      console.error(`photoBadge: no ${marketplace} logo (${err.message}) — photos go without it`);
      logos[marketplace] = null;
    }
  }
  return logos[marketplace];
}

let sharpLib;
function loadSharp() {
  if (sharpLib === undefined) {
    try {
      sharpLib = require('sharp');
    } catch (err) {
      console.error(`photoBadge: sharp unavailable (${err.message}) — photos go without the logo`);
      sharpLib = null;
    }
  }
  return sharpLib;
}

// The photo, at most MAX_SIDE, with the logo on a white rounded tag in the
// top-left corner. null for a photo too small to carry it.
async function drawBadge(sharp, logo, url) {
  const res = await axios.get(url, { responseType: 'arraybuffer', timeout: FETCH_TIMEOUT_MS, maxContentLength: MAX_PHOTO_BYTES });
  const base = await sharp(Buffer.from(res.data), { failOn: 'none' })
    .rotate()
    .resize({ width: MAX_SIDE, height: MAX_SIDE, fit: 'inside', withoutEnlargement: true })
    .flatten({ background: '#ffffff' })
    .toBuffer({ resolveWithObject: true });
  const { width, height } = base.info;
  const short = Math.min(width, height);
  const tagH = Math.max(32, Math.round(short * 0.09));
  const padY = Math.round(tagH * 0.2);
  const padX = Math.round(tagH * 0.32);
  const mark = await sharp(logo).resize({ height: tagH - 2 * padY }).toBuffer({ resolveWithObject: true });
  const tagW = mark.info.width + 2 * padX;
  const margin = Math.max(6, Math.round(short * 0.03));
  if (margin + tagW > width * 0.6 || margin + tagH > height * 0.3) return null;
  const tag = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${tagW}" height="${tagH}">` +
      `<rect x="0.5" y="0.5" width="${tagW - 1}" height="${tagH - 1}" rx="${Math.round(tagH * 0.24)}" fill="#ffffff" fill-opacity="0.95" stroke="#000000" stroke-opacity="0.14"/>` +
      `</svg>`,
  );
  return sharp(base.data)
    .composite([
      { input: tag, left: margin, top: margin },
      { input: mark.data, left: margin + padX, top: margin + padY },
    ])
    .jpeg({ quality: 88 })
    .toBuffer();
}

async function badgePhotos(photos, marketplace) {
  const logo = photos.length ? logoFor(marketplace) : null;
  const sharp = logo ? loadSharp() : null;
  if (!sharp) return photos;
  // A qty-2 line is the same photo twice — drawn once.
  const drawn = new Map();
  return Promise.all(
    photos.map(async (url) => {
      if (!drawn.has(url)) {
        drawn.set(
          url,
          drawBadge(sharp, logo, url).catch((err) => {
            console.error(`photoBadge: ${url} — ${err.message}; sent without the logo`);
            return null;
          }),
        );
      }
      const file = await drawn.get(url);
      return file ? { file, url } : url;
    }),
  );
}

module.exports = { badgePhotos };
