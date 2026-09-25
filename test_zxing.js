const fs = require('fs');
const { PNG } = require('pngjs');
const { MultiFormatReader, BarcodeFormat, DecodeHintType, BinaryBitmap, HybridBinarizer, GlobalHistogramBinarizer, RGBLuminanceSource } = require('@zxing/library');

const HINTS = new Map();
HINTS.set(DecodeHintType.POSSIBLE_FORMATS, [BarcodeFormat.CODE_128, BarcodeFormat.CODE_39, BarcodeFormat.EAN_13, BarcodeFormat.ITF]);
HINTS.set(DecodeHintType.TRY_HARDER, true);

function stretchGray(data, width, height) {
  const n = width * height;
  const hist = new Uint32Array(256);
  for (let i = 0, p = 0; i < n; i++, p += 4) {
    const g = (data[p] * 77 + data[p + 1] * 150 + data[p + 2] * 29) >> 8;
    data[p] = g;
    hist[g]++;
  }
  const loT = n * 0.01;
  const hiT = n * 0.99;
  let lo = 0;
  let hi = 255;
  for (let v = 0, acc = 0; v < 256; v++) {
    acc += hist[v];
    if (acc >= loT) { lo = v; break; }
  }
  for (let v = 0, acc = 0; v < 256; v++) {
    acc += hist[v];
    if (acc >= hiT) { hi = v; break; }
  }
  const range = Math.max(hi - lo, 1);
  const lut = new Uint8ClampedArray(256);
  for (let v = 0; v < 256; v++) lut[v] = range < 8 ? v : ((v - lo) * 255) / range;
  
  const out = new Uint8ClampedArray(data.length);
  for (let i = 0, p = 0; i < n; i++, p += 4) {
    const g = lut[data[p]];
    out[p] = g;
    out[p + 1] = g;
    out[p + 2] = g;
    out[p + 3] = 255;
  }
  return out;
}

function smoothAlongBars(data, width, height, radius) {
  const n = width * height;
  const out = new Uint8ClampedArray(data.length);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let sum = 0, count = 0;
      for (let dy = -radius; dy <= radius; dy++) {
        const ny = y + dy;
        if (ny >= 0 && ny < height) {
          sum += data[(ny * width + x) * 4];
          count++;
        }
      }
      const val = sum / count;
      const p = (y * width + x) * 4;
      out[p] = val;
      out[p+1] = val;
      out[p+2] = val;
      out[p+3] = 255;
    }
  }
  return out;
}

function luminance(data, width, height) {
  const n = width * height;
  const lum = new Uint8ClampedArray(n);
  for (let i = 0, p = 0; i < n; i++, p += 4) lum[i] = data[p]; // assuming grayscale
  return lum;
}

function tryDecode(name, data, width, height) {
  const lum = luminance(data, width, height);
  const src = new RGBLuminanceSource(lum, width, height);
  const reader = new MultiFormatReader();
  reader.setHints(HINTS);

  try {
    const result = reader.decode(new BinaryBitmap(new HybridBinarizer(src)), HINTS);
    console.log(`${name} (Hybrid): SUCCESS = ${result.getText()}`);
  } catch (e) {
    console.log(`${name} (Hybrid): FAILED`);
  }

  try {
    const result = reader.decode(new BinaryBitmap(new GlobalHistogramBinarizer(src)), HINTS);
    console.log(`${name} (Global): SUCCESS = ${result.getText()}`);
  } catch (e) {
    console.log(`${name} (Global): FAILED`);
  }
}

const data = fs.readFileSync('/Users/gauravbhandari/.gemini/antigravity/brain/d50c8de3-024a-457f-bf96-0d9e06b407e2/.user_uploaded/media_1790335353363.png');
const png = PNG.sync.read(data);

console.log(`Loaded PNG: ${png.width}x${png.height}`);

tryDecode('RAW', png.data, png.width, png.height);

const stretched = stretchGray(png.data, png.width, png.height);
tryDecode('STRETCHED', stretched, png.width, png.height);

const smoothed = smoothAlongBars(png.data, png.width, png.height, 4);
const smoothStretched = stretchGray(smoothed, png.width, png.height);
tryDecode('SMOOTH+STRETCH', smoothStretched, png.width, png.height);

