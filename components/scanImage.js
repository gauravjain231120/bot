// Image clean-up + "is this read trustworthy?" rules shared by the camera
// scanners (BarcodeScanner, TextIdScanner). Everything here works on plain
// ImageData-shaped objects ({ data: RGBA bytes, width, height }) — no DOM —
// so it runs the same in the browser and in offline tests.
//
// Why: for OCR a faint / low-ink print is a CONTRAST problem — light grey
// digits on white. Stretching the picture's own darkest-to-lightest range to
// full black-to-white makes faint ink properly dark before tesseract runs.
// (Barcodes get their own edge-based clean-up: barcodeLines.js.)

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
// A check digit is not enough on its own: the scanner decodes hundreds of
// lines a second, and Code 128's mod-103 check (EAN's mod-10 even more so)
// lets the odd random line through as junk like ":" or "E$'{?:" (seen in
// offline testing). So a read must first LOOK like a tracking / order /
// packet id — 6+ letters/digits (dashes allowed), nothing else — and then:
//   - a Myntra id (MY + 2 letters + 8+ digits) in Code 128 counts at once —
//     noise can't produce that shape AND pass the check character;
//   - anything else needs the same text a second time within a few seconds
//     (another scan line, frame, or the phone's own reader).
const PLAUSIBLE_ID = /^[A-Z0-9][A-Z0-9-]{4,38}[A-Z0-9]$/i;
const MYNTRA_BARCODE = /^MY[A-Z]{2}\d{8,}$/;
const CODE_128 = new Set(['CODE_128', 'code_128']);

export function looksLikeId(text) {
  return PLAUSIBLE_ID.test(String(text || '').trim());
}

export function createBarcodeConfirmer({ windowMs = 4000, now = () => Date.now() } = {}) {
  const seen = new Map(); // text -> when first read
  return function confirm(text, format) {
    const t = String(text || '').trim();
    if (!looksLikeId(t)) return null;
    if (CODE_128.has(String(format)) && MYNTRA_BARCODE.test(t)) return t;
    const at = now();
    for (const [k, when] of seen) if (at - when > windowMs) seen.delete(k);
    if (seen.has(t)) return t;
    seen.set(t, at);
    return null;
  };
}

// ---- OCR ids: when is a read good enough? ----
// OCR's typical mistake is one digit misread (0↔8, 5↔6, 3↔8…), and it can
// repeat the same mistake on a few frames running. So an id only counts when:
//   - it was read at least 3 times in the last 8 reads,
//   - from both image sizes (frames alternate normal / 1.5x — a digit
//     misread at one size rarely repeats at the other), and
//   - no read in that window disagreed by just 1–2 characters (a "rival":
//     some frames see 0, some 8). Then the camera must look again — the
//     scanner shows both readings (vote.rival) so the user can move closer.
// Wrong ids are the expensive failure (a lookup of the wrong return /
// order), so this trades a moment of extra reading for never guessing.
export function createIdVoter({ history = 8, need = 3 } = {}) {
  const reads = [];
  function vote(read) {
    vote.rival = null;
    if (!read || !read.id) return null;
    reads.push(read);
    if (reads.length > history) reads.shift();
    const rival = reads.find((r) => r.id !== read.id && nearMiss(r.id, read.id));
    if (rival) {
      vote.rival = rival.id;
      return null;
    }
    const same = reads.filter((r) => r.id === read.id);
    if (same.length >= need && new Set(same.map((r) => r.variant)).size >= 2) return read.id;
    return null;
  }
  vote.rival = null;
  return vote;
}

// Same length and 1–2 characters different: the same id with a misread.
export function nearMiss(a, b) {
  const x = String(a).replace(/-/g, '');
  const y = String(b).replace(/-/g, '');
  if (x.length !== y.length) return false;
  let diff = 0;
  for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) diff++;
  return diff > 0 && diff <= 2;
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

// Myntra tracking ids: MY + 2 letters + 10 digits (MYSR…, MYSP…, MYSC…,
// MYEC…, MYEP…, MYER… — every real one seen so far has exactly 10 digits).
// Exactly 10, so a dropped or doubled digit is never accepted. Matched one
// line at a time; nothing alphanumeric may follow the last digit, but junk
// glued in front is fine (OCR often runs a stray letter into the "M"). OCR's
// usual letter/digit swaps are undone position by position: the prefix is
// letters (5→S, 8→R, H misread for M, V/W for Y), the tail is digits
// (O/D/Q→0, I/L→1, Z→2, S→5, G→6, B→8).
const MYNTRA_ID_RE = /([MH][YVW]) ?([A-Z0-9]{2}) ?([A-Z0-9]{10})(?![A-Z0-9])/g;
const TAIL_DIGIT = { O: '0', D: '0', Q: '0', I: '1', L: '1', Z: '2', S: '5', G: '6', B: '8' };
const PREFIX_LETTER = { 5: 'S', 8: 'R' };

export function readMyntraId(text) {
  for (const line of String(text || '').split(/\r?\n/)) {
    const cleaned = line.toUpperCase().replace(/[\-–—_.|]/g, '').replace(/\s+/g, ' ');
    for (const m of cleaned.matchAll(MYNTRA_ID_RE)) {
      const prefix = 'MY' + [...m[2]].map((c) => PREFIX_LETTER[c] || c).join('');
      const tail = [...m[3]].map((c) => TAIL_DIGIT[c] || c).join('');
      const id = prefix + tail;
      if (/^MY[SE][A-Z]\d{10}$/.test(id)) return id;
    }
  }
  return null;
}
