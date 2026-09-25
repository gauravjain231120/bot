const fs = require('fs');
const { PNG } = require('pngjs');
const { MultiFormatReader, BarcodeFormat, DecodeHintType, BinaryBitmap, HybridBinarizer, GlobalHistogramBinarizer, RGBLuminanceSource } = require('@zxing/library');

const HINTS = new Map();
HINTS.set(DecodeHintType.POSSIBLE_FORMATS, [BarcodeFormat.CODE_128, BarcodeFormat.CODE_39, BarcodeFormat.EAN_13, BarcodeFormat.ITF]);
HINTS.set(DecodeHintType.TRY_HARDER, true);

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
}

const data = fs.readFileSync('/Users/gauravbhandari/.gemini/antigravity/brain/d50c8de3-024a-457f-bf96-0d9e06b407e2/.user_uploaded/media_1790335353363.png');
const png = PNG.sync.read(data);

// Add 50px white padding on all sides
const pad = 50;
const w = png.width + pad * 2;
const h = png.height + pad * 2;
const padded = new Uint8ClampedArray(w * h * 4);
padded.fill(255); // white

for (let y = 0; y < png.height; y++) {
  for (let x = 0; x < png.width; x++) {
    const src = (y * png.width + x) * 4;
    const dst = ((y + pad) * w + (x + pad)) * 4;
    padded[dst] = png.data[src];
    padded[dst+1] = png.data[src+1];
    padded[dst+2] = png.data[src+2];
    padded[dst+3] = 255;
  }
}

tryDecode('PADDED', padded, w, h);

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

tryDecode('PADDED+STRETCHED (Hybrid)', stretchGray(padded, w, h), w, h);

function dilateWhites(data, width, height) {
  const n = width * height;
  const out = new Uint8ClampedArray(data.length);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let maxVal = 0;
      for (let dx = -1; dx <= 1; dx++) {
        const nx = x + dx;
        if (nx >= 0 && nx < width) {
          const val = data[(y * width + nx) * 4];
          if (val > maxVal) maxVal = val;
        }
      }
      const p = (y * width + x) * 4;
      out[p] = maxVal;
      out[p+1] = maxVal;
      out[p+2] = maxVal;
      out[p+3] = 255;
    }
  }
  return out;
}

tryDecode('PADDED+DILATE_WHITES (Hybrid)', dilateWhites(padded, w, h), w, h);
tryDecode('PADDED+STRETCH+DILATE (Hybrid)', dilateWhites(stretchGray(padded, w, h), w, h), w, h);


function dilateBlacks(data, width, height) {
  const n = width * height;
  const out = new Uint8ClampedArray(data.length);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let minVal = 255;
      for (let dx = -1; dx <= 1; dx++) {
        const nx = x + dx;
        if (nx >= 0 && nx < width) {
          const val = data[(y * width + nx) * 4];
          if (val < minVal) minVal = val;
        }
      }
      const p = (y * width + x) * 4;
      out[p] = minVal;
      out[p+1] = minVal;
      out[p+2] = minVal;
      out[p+3] = 255;
    }
  }
  return out;
}

tryDecode('PADDED+DILATE_BLACKS (Hybrid)', dilateBlacks(padded, w, h), w, h);
tryDecode('PADDED+STRETCH+DILATE_BLACKS (Hybrid)', dilateBlacks(stretchGray(padded, w, h), w, h), w, h);


function blur(data, width, height) {
  const n = width * height;
  const out = new Uint8ClampedArray(data.length);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let sum = 0, count = 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx >= 0 && nx < width && ny >= 0 && ny < height) {
            sum += data[(ny * width + nx) * 4];
            count++;
          }
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

tryDecode('PADDED+BLUR', blur(padded, w, h), w, h);
tryDecode('PADDED+STRETCH+BLUR', stretchGray(blur(padded, w, h), w, h), w, h);
tryDecode('PADDED+BLUR+STRETCH', blur(stretchGray(padded, w, h), w, h), w, h);


function hardThreshold(data, width, height, thresh) {
  const n = width * height;
  const out = new Uint8ClampedArray(data.length);
  for (let i = 0, p = 0; i < n; i++, p += 4) {
    const v = data[p] < thresh ? 0 : 255;
    out[p] = v;
    out[p+1] = v;
    out[p+2] = v;
    out[p+3] = 255;
  }
  return out;
}

tryDecode('PADDED+HARD(128)', hardThreshold(padded, w, h, 128), w, h);
tryDecode('PADDED+HARD(160)', hardThreshold(padded, w, h, 160), w, h);
tryDecode('PADDED+HARD(90)', hardThreshold(padded, w, h, 90), w, h);


function scaleDown(data, width, height) {
  const nw = Math.floor(width / 2);
  const nh = Math.floor(height / 2);
  const out = new Uint8ClampedArray(nw * nh * 4);
  for (let y = 0; y < nh; y++) {
    for (let x = 0; x < nw; x++) {
      let sum = 0;
      for (let dy = 0; dy < 2; dy++) {
        for (let dx = 0; dx < 2; dx++) {
          sum += data[((y * 2 + dy) * width + (x * 2 + dx)) * 4];
        }
      }
      const val = sum / 4;
      const p = (y * nw + x) * 4;
      out[p] = val;
      out[p+1] = val;
      out[p+2] = val;
      out[p+3] = 255;
    }
  }
  return { data: out, width: nw, height: nh };
}

const scaled = scaleDown(padded, w, h);
tryDecode('PADDED+SCALED', scaled.data, scaled.width, scaled.height);

const scaledStretched = stretchGray(scaled.data, scaled.width, scaled.height);
tryDecode('PADDED+SCALED+STRETCHED', scaledStretched, scaled.width, scaled.height);


const scaled4 = scaleDown(scaled.data, scaled.width, scaled.height);
tryDecode('PADDED+SCALED4', scaled4.data, scaled4.width, scaled4.height);
tryDecode('PADDED+SCALED4+STRETCHED', stretchGray(scaled4.data, scaled4.width, scaled4.height), scaled4.width, scaled4.height);


function scaleUp(data, width, height) {
  const nw = width * 2;
  const nh = height * 2;
  const out = new Uint8ClampedArray(nw * nh * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const p = (y * width + x) * 4;
      const r = data[p], g = data[p+1], b = data[p+2], a = data[p+3];
      
      const p1 = ( (y*2) * nw + (x*2) ) * 4;
      const p2 = ( (y*2) * nw + (x*2+1) ) * 4;
      const p3 = ( (y*2+1) * nw + (x*2) ) * 4;
      const p4 = ( (y*2+1) * nw + (x*2+1) ) * 4;
      
      out[p1] = out[p2] = out[p3] = out[p4] = r;
      out[p1+1] = out[p2+1] = out[p3+1] = out[p4+1] = g;
      out[p1+2] = out[p2+2] = out[p3+2] = out[p4+2] = b;
      out[p1+3] = out[p2+3] = out[p3+3] = out[p4+3] = a;
    }
  }
  return { data: out, width: nw, height: nh };
}

const scaledUp = scaleUp(padded, w, h);
tryDecode('PADDED+SCALED_UP', scaledUp.data, scaledUp.width, scaledUp.height);
tryDecode('PADDED+SCALED_UP+STRETCHED', stretchGray(scaledUp.data, scaledUp.width, scaledUp.height), scaledUp.width, scaledUp.height);

