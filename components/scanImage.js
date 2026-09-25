// Image clean-up + "is this read trustworthy?" rules shared by the camera
// scanners (BarcodeScanner, OrderIdScanner). Everything here works on plain
// ImageData-shaped objects ({ data: RGBA bytes, width, height }) — no DOM —
// so it runs the same in the browser and in offline tests.
//
// Why: a faint / low-ink print is a CONTRAST problem. The bars or digits are
// light grey on white, so the decoder's own black/white threshold either
// misses them (barcode "not found") or guesses wrong (OCR reads 8 for 3).
// Stretching the picture's own darkest-to-lightest range to full black-to-
// white makes faint ink properly dark before any decoding happens.

/**
 * In place: grayscale + contrast stretch. The 1st-percentile grey becomes
 * black and the 99th becomes white (percentiles, not min/max, so a speck of
 * glare or dirt can't set the range). A frame that's already flat (a blank
 * area, range under 8 levels) is only greyed, never noise-amplified.
 */
export function stretchGray(img) {
  const { data, width, height } = img;
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
    if (acc >= loT) {
      lo = v;
      break;
    }
  }
  for (let v = 0, acc = 0; v < 256; v++) {
    acc += hist[v];
    if (acc >= hiT) {
      hi = v;
      break;
    }
  }
  const range = hi - lo;
  const lut = new Uint8ClampedArray(256);
  for (let v = 0; v < 256; v++) lut[v] = range < 8 ? v : ((v - lo) * 255) / range;
  for (let i = 0, p = 0; i < n; i++, p += 4) {
    const g = lut[data[p]];
    data[p] = g;
    data[p + 1] = g;
    data[p + 2] = g;
    data[p + 3] = 255;
  }
  return img;
}

/**
 * In place: average each pixel with the ones above/below it (a vertical box
 * blur). Once a frame is turned so the barcode's bars run vertically, this
 * removes camera noise/speckle — the main thing hiding a faint print — while
 * leaving the bars themselves (which don't change top-to-bottom) sharp.
 * Only the grey channel is read; all three are written.
 */
export function smoothAlongBars(img, radius = 3) {
  const { data, width: w, height: h } = img;
  const col = new Float32Array(h);
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) col[y] = data[(y * w + x) * 4];
    let sum = 0;
    let count = 0;
    for (let y = 0; y < Math.min(h, radius + 1); y++) {
      sum += col[y];
      count++;
    }
    for (let y = 0; y < h; y++) {
      const add = y + radius + 1;
      const drop = y - radius;
      const p = (y * w + x) * 4;
      const g = sum / count;
      data[p] = g;
      data[p + 1] = g;
      data[p + 2] = g;
      if (add < h) {
        sum += col[add];
        count++;
      }
      if (drop >= 0) {
        sum -= col[drop];
        count--;
      }
    }
  }
  return img;
}

/**
 * How far the text in `img` is tilted, in degrees CLOCKWISE (screen
 * coordinates, y down) — so rotating the picture by the negative of this
 * (counter-clockwise) straightens it. Found
 * by the classic projection-profile method: for each candidate angle, count
 * dark pixels per text row as if the picture were turned by that angle — when
 * the rows line up with the text lines, the counts are most "peaky" (high
 * variance). Works on a downscaled copy, so it costs a few ms.
 * Returns the angle (within ±maxDeg) that straightens the text.
 */
export function estimateSkew(img, { maxDeg = 12, stepDeg = 1, sampleWidth = 480 } = {}) {
  const { data, width: w, height: h } = img;
  const k = Math.min(1, sampleWidth / w);
  const sw = Math.max(1, Math.round(w * k));
  const sh = Math.max(1, Math.round(h * k));
  // Dark pixels of a downscaled grey copy (threshold = mean - a margin).
  const grey = new Float32Array(sw * sh);
  let mean = 0;
  for (let y = 0; y < sh; y++) {
    for (let x = 0; x < sw; x++) {
      const p = (Math.min(h - 1, Math.floor(y / k)) * w + Math.min(w - 1, Math.floor(x / k))) * 4;
      const g = (data[p] * 77 + data[p + 1] * 150 + data[p + 2] * 29) >> 8;
      grey[y * sw + x] = g;
      mean += g;
    }
  }
  mean /= sw * sh;
  const xs = [];
  const ys = [];
  for (let y = 0; y < sh; y++) {
    for (let x = 0; x < sw; x++) {
      if (grey[y * sw + x] < mean * 0.8) {
        xs.push(x - sw / 2);
        ys.push(y - sh / 2);
      }
    }
  }
  if (xs.length < 50) return 0;
  const diag = Math.ceil(Math.hypot(sw, sh));
  let best = 0;
  let bestScore = -1;
  for (let deg = -maxDeg; deg <= maxDeg + 1e-9; deg += stepDeg) {
    const a = (deg * Math.PI) / 180;
    const sin = Math.sin(a);
    const cos = Math.cos(a);
    const rows = new Float32Array(diag * 2);
    for (let i = 0; i < xs.length; i++) {
      const r = Math.round(ys[i] * cos - xs[i] * sin) + diag;
      rows[r]++;
    }
    let sum = 0;
    let sumSq = 0;
    for (let r = 0; r < rows.length; r++) {
      sum += rows[r];
      sumSq += rows[r] * rows[r];
    }
    const score = sumSq - (sum * sum) / rows.length;
    if (score > bestScore) {
      bestScore = score;
      best = deg;
    }
  }
  return best;
}

// ---- Barcode: when is a read good enough? ----
// Code 128 / EAN / UPC carry a check digit — a misread almost never passes
// it, so the first read counts. Code 39 / ITF / Codabar have no mandatory
// check digit: on a faint print a bar can be misjudged and still decode to a
// wrong-but-valid-looking code, so those need the SAME text twice in a row.
const CHECKSUMMED = new Set(['CODE_128', 'EAN_13', 'EAN_8', 'UPC_A', 'UPC_E', 'code_128', 'ean_13', 'ean_8', 'upc_a', 'upc_e']);

export function createBarcodeConfirmer() {
  let last = null;
  return function confirm(text, format) {
    const t = String(text || '').trim();
    if (!t) return null;
    if (CHECKSUMMED.has(String(format))) return t;
    if (last === t) return t;
    last = t;
    return null;
  };
}

// ---- Amazon order id (OCR): when is a read good enough? ----
// OCR can misread a faint digit the same way twice in a row (the old rule),
// so an id is only accepted when it's been read:
//   - twice with high per-digit confidence AND from two different image
//     sizes (the scanner alternates normal and 1.5x — a wrong digit at one
//     size rarely repeats at the other), or
//   - three times in the last six reads, whatever the confidence.
// A read that disagrees just doesn't add up — it never "wins" alone.
export const STRONG_CONFIDENCE = 80;

export function createOrderIdVoter({ history = 6 } = {}) {
  const reads = [];
  return function vote(read) {
    if (!read || !read.id) return null;
    reads.push(read);
    if (reads.length > history) reads.shift();
    const same = reads.filter((r) => r.id === read.id);
    if (same.length >= 3) return read.id;
    const strong = same.filter((r) => r.confidence >= STRONG_CONFIDENCE);
    if (strong.length >= 2 && new Set(strong.map((r) => r.variant)).size >= 2) return read.id;
    return null;
  };
}

// Amazon order ids are 3-7-7 digits. Matched ONE LINE AT A TIME and only
// with no other digit touching either end — otherwise the reader happily
// glues the id's last group onto the date on the next line ("280-4187546-
// 2309120", seen in testing). Letters OCR commonly mistakes for digits are
// mapped first (O->0, I/l/|->1, S->5, B->8) — the digit whitelist mostly
// prevents them, this is the safety net.
const ORDER_ID_RE = /(?:^|[^0-9])(\d{3})[ \t\-–—_.]{0,3}(\d{7})[ \t\-–—_.]{0,3}(\d{7})(?![0-9])/;

export function readOrderId(text) {
  for (const line of String(text || '').split(/\r?\n/)) {
    const cleaned = line
      .replace(/[Oo]/g, '0')
      .replace(/[Il|]/g, '1')
      .replace(/S/g, '5')
      .replace(/B/g, '8');
    const m = cleaned.match(ORDER_ID_RE);
    if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  }
  return null;
}

/**
 * The lowest per-character confidence (0-100) among the digits of `id` in a
 * tesseract result, or null if they can't be located. One weak digit is
 * exactly what makes a wrong read, so the minimum — not the average — counts.
 *
 * tesseract.js 6 reports 0 for the FIRST character of every word whatever it
 * really is (seen on clean, perfectly-read test images), so that one position
 * is skipped; the voter's "read it again" rule still covers it.
 */
export function orderIdConfidence(page, id) {
  const digits = id.replace(/-/g, '');
  for (const block of (page && page.blocks) || []) {
    for (const para of block.paragraphs || []) {
      for (const line of para.lines || []) {
        const ds = [];
        for (const word of line.words || []) {
          (word.symbols || []).forEach((sym, i) => {
            if (/^\d$/.test(sym.text)) ds.push({ ch: sym.text, conf: i === 0 ? null : sym.confidence });
          });
        }
        const joined = ds.map((d) => d.ch).join('');
        const at = joined.indexOf(digits);
        if (at >= 0) {
          const confs = ds.slice(at, at + digits.length).map((d) => d.conf).filter((c) => c != null);
          return confs.length ? Math.min(...confs) : null;
        }
      }
    }
  }
  return null;
}

export function createMyntraIdVoter({ history = 6 } = {}) {
  const reads = [];
  return function vote(read) {
    if (!read || !read.id) return null;
    reads.push(read);
    if (reads.length > history) reads.shift();
    const same = reads.filter((r) => r.id === read.id);
    if (same.length >= 3) return read.id;
    const strong = same.filter((r) => r.confidence >= STRONG_CONFIDENCE);
    if (strong.length >= 2 && new Set(strong.map((r) => r.variant)).size >= 2) return read.id;
    return null;
  };
}

const MYNTRA_ID_RE = /(?:^|[^A-Z0-9])(MY[A-Z0-9]{2}[0-9]{8,15})(?![A-Z0-9])/i;

export function readMyntraId(text) {
  for (const line of String(text || '').split(/\r?\n/)) {
    let cleaned = line.toUpperCase().replace(/\s+/g, '');
    // Common OCR letter-to-digit mistakes inside the prefix
    cleaned = cleaned.replace(/M[YV][5S][R8]/, 'MYSR').replace(/M[YV]E[C\(\[]/, 'MYEC');
    const m = cleaned.match(MYNTRA_ID_RE);
    if (m) return m[1];
  }
  return null;
}

export function myntraIdConfidence(page, id) {
  for (const block of (page && page.blocks) || []) {
    for (const para of block.paragraphs || []) {
      for (const line of para.lines || []) {
        const cs = [];
        for (const word of line.words || []) {
          (word.symbols || []).forEach((sym, i) => {
            if (/^[A-Z0-9]$/i.test(sym.text)) cs.push({ ch: sym.text.toUpperCase(), conf: i === 0 ? null : sym.confidence });
          });
        }
        const joined = cs.map((c) => c.ch).join('');
        const at = joined.indexOf(id);
        if (at >= 0) {
          const confs = cs.slice(at, at + id.length).map((c) => c.conf).filter((c) => c != null);
          return confs.length ? Math.min(...confs) : null;
        }
      }
    }
  }
  return null;
}
