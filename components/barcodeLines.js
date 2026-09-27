// Barcode scan lines — turns a grey camera frame (already turned so the bars
// run roughly up-down) into a short stack of clean black/white lines for
// zxing's 1D readers. DOM-free: runs in the scanner's worker and in offline
// tests alike.
//
// Why: zxing picks ONE grey threshold per row (GlobalHistogramBinarizer —
// HybridBinarizer only differs for 2D codes). On a faint / low-ink print, a
// slightly blurred frame, or a label lying on a dark bag, that one level loses
// the thin bars and spaces, so light prints never scanned. Instead, per line:
//  1. a few frame rows are averaged — the bars run up-down, so this removes
//     camera noise without blurring them;
//  2. bar edges are placed where the brightness changes fastest (gradient
//     peaks, to a fraction of a pixel). Blur makes narrow bars paler than wide
//     ones, which breaks any fixed threshold, but leaves edge positions where
//     they are — and how dark the ink is doesn't matter, only that an edge
//     stands out from the row's own noise;
//  3. an edge much weaker than the strong edges around it is a ripple (streak
//     or smudge) and is dropped;
//  4. extra versions first close hairline white gaps (up to ~1 module): a
//     worn thermal head splits wide bars with a thin white streak, which made
//     a real MYSR… label unreadable by zxing at any threshold.
// Code 128 carries a check character, so a bad line just fails to decode;
// scanImage.createBarcodeConfirmer adds the "does this look like a real id"
// rule on top.

const DEFAULTS = {
  strips: 40, // lines spread down the frame
  radii: [2, 6], // rows averaged each side: 2 = sharp, 6 = quiet (faint print)
  up: 2, // lines are written at 2x width so sub-pixel edges survive rounding
  gate: 6, // minimum edge contrast, grey levels
  gateK: 5, // ...or this many times the row's noise, whichever is higher
  ripple: 0.35, // edges weaker than this share of their strong neighbours are dropped
  closeFracs: [0.75, 1.05, 1.35], // hairline-gap closing widths, in modules
  minEdges: 24, // fewer edges than this can't be a tracking barcode: line skipped
};

/**
 * @param {Uint8ClampedArray|Uint8Array} lum grey frame, w*h
 * @returns {{ lum: Uint8ClampedArray, w: number, h: number }} black (0) / white (255)
 *   lines, one per row — h is 0 when nothing in the frame looks like a barcode.
 */
export function scanLines(lum, w, h, opts = {}) {
  const { strips, radii, up, gate, gateK, ripple, closeFracs, minEdges } = { ...DEFAULTS, ...opts };
  const W = Math.max(24, Math.round(w / 40)); // neighbourhood for ripple / level checks
  const OW = w * up;
  const perStrip = radii.length * (1 + closeFracs.length);
  const out = new Uint8ClampedArray(OW * strips * perStrip);
  const row = new Float32Array(w);
  const closed = new Float32Array(w);
  const tmp = new Float32Array(w);
  const mx = new Float32Array(w);
  const mn = new Float32Array(w);
  const d = new Float32Array(w);
  const dq = new Int32Array(w + 1);
  const E = { pos: new Float32Array(w), pol: new Int8Array(w), mag: new Float32Array(w), keep: new Uint8Array(w) };
  const widths = new Float32Array(w);
  const hist = new Uint32Array(64);
  const margin = Math.max(...radii);
  let lines = 0;
  for (let s = 0; s < strips; s++) {
    const cy = Math.round(margin + ((s + 0.5) / strips) * (h - 2 * margin - 1));
    for (const r of radii) {
      row.fill(0);
      for (let y = cy - r; y <= cy + r; y++) {
        const b = y * w;
        for (let x = 0; x < w; x++) row[x] += lum[b + x];
      }
      const k = 1 / (2 * r + 1);
      for (let x = 0; x < w; x++) row[x] *= k;

      // Noise: the median step between neighbouring pixels (edges are a small
      // minority of steps, so they don't move the median).
      hist.fill(0);
      for (let x = 1; x < w; x++) hist[Math.min(63, (Math.abs(row[x] - row[x - 1]) * 4) | 0)]++;
      let acc = 0;
      let med = 0;
      for (; med < 63; med++) {
        acc += hist[med];
        if (acc * 2 >= w - 1) break;
      }
      const minEdge = Math.max(gate / 3, (med / 4) * gateK * 0.5);

      const n = findEdges(row, w, minEdge, W, ripple, d, E);
      if (n < minEdges) continue;
      const spread = inkSpread(E, n, W, widths);
      paint(row, w, n, E, W, up, mx, mn, dq, out, lines++ * OW, spread);

      // Module (narrowest bar) width: a low percentile of element widths in
      // busy stretches — about half of Code 128's elements are 1 module.
      let nw = 0;
      for (let i = 0; i < n - 1; i++) {
        const gw = E.pos[i + 1] - E.pos[i];
        if (gw < W / 2) widths[nw++] = gw;
      }
      if (nw < minEdges) continue;
      const mod = quantile(widths, nw, 0.3);
      const done = [];
      for (const f of closeFracs) {
        const hw = Math.round((f * mod - 1) / 2); // window 2*hw+1 ≈ f modules
        if (hw < 1 || done.includes(hw)) continue;
        done.push(hw);
        slidingExtreme(row, w, hw, tmp, dq, false);
        slidingExtreme(tmp, w, hw, closed, dq, true);
        const m = findEdges(closed, w, minEdge, W, ripple, d, E);
        if (m >= minEdges) paint(closed, w, m, E, W, up, mx, mn, dq, out, lines++ * OW, inkSpread(E, m, W, tmp));
      }
    }
  }
  return { lum: out.subarray(0, lines * OW), w: OW, h: lines };
}

// Gradient peaks above minEdge (sub-pixel), minus ripples. Fills E, returns count.
function findEdges(src, w, minEdge, W, ripple, d, E) {
  const { pos, pol, mag, keep } = E;
  d[0] = 0;
  d[w - 1] = 0;
  for (let x = 1; x < w - 1; x++) d[x] = (src[x + 1] - src[x - 1]) / 2;
  let n = 0;
  for (let x = 2; x < w - 2; x++) {
    const a = Math.abs(d[x]);
    if (a < minEdge) continue;
    const l = Math.abs(d[x - 1]);
    const r = Math.abs(d[x + 1]);
    if (!(a >= l && a > r)) continue;
    const den = l - 2 * a + r; // parabola through the 3 points → sub-pixel peak
    pos[n] = x + (den < 0 ? (0.5 * (l - r)) / den : 0);
    pol[n] = d[x] < 0 ? -1 : 1;
    mag[n] = a;
    n++;
  }
  for (let i = 0; i < n; i++) {
    let ref = 0;
    for (let j = i - 1; j >= 0 && pos[i] - pos[j] < W; j--) if (mag[j] > ref) ref = mag[j];
    for (let j = i + 1; j < n && pos[j] - pos[i] < W; j++) if (mag[j] > ref) ref = mag[j];
    keep[i] = mag[i] >= ripple * ref ? 1 : 0;
  }
  let m = 0;
  for (let i = 0; i < n; i++) {
    if (!keep[i]) continue;
    pos[m] = pos[i];
    pol[m] = pol[i];
    mag[m] = mag[i];
    m++;
  }
  return m;
}

// Writes one line at out[o…]: falling edge → rising edge = bar, rising →
// falling = space. Two edges the same way round bound a mid-grey step (label
// edge, shadow): wider than any bar can be, it's paper (keeps the quiet zone
// zxing needs); otherwise it's judged by its level against the local
// black/white midpoint.
function paint(src, w, n, E, W, up, mx, mn, dq, out, o, spread = 0) {
  const { pos, pol } = E;
  const OW = w * up;
  out.fill(255, o, o + OW);
  let levels = false;
  for (let i = 0; i < n - 1; i++) {
    let bar;
    if (pol[i] === -1 && pol[i + 1] === 1) bar = true;
    else if (pol[i] === 1 && pol[i + 1] === -1) bar = false;
    else if (pos[i + 1] - pos[i] > W / 2) bar = false;
    else {
      if (!levels) {
        slidingExtreme(src, w, W, mx, dq, true);
        slidingExtreme(src, w, W, mn, dq, false);
        levels = true;
      }
      const c = Math.round((pos[i] + pos[i + 1]) / 2);
      bar = src[c] < (mx[c] + mn[c]) / 2;
    }
    if (!bar) continue;
    const a = Math.round((pos[i] + 0.5 + spread / 2) * up);
    const b = Math.round((pos[i + 1] + 0.5 - spread / 2) * up);
    out.fill(0, o + Math.max(0, a), o + Math.min(OW, b));
  }
}

// Ink spread / bleed: how much wider than nominal the bars print (negative =
// thinner, a starved thermal head). Bars and spaces of 1 module should be
// equally wide; half the difference between the narrow bars and the narrow
// spaces is taken off each bar edge (added, if negative) when painting.
function inkSpread(E, n, W, buf) {
  const { pos, pol } = E;
  let nb = 0;
  let ns = 0;
  const half = buf.length >> 1;
  for (let i = 0; i < n - 1; i++) {
    const gw = pos[i + 1] - pos[i];
    if (gw >= W / 2) continue;
    if (pol[i] === -1 && pol[i + 1] === 1) buf[nb++] = gw;
    else if (pol[i] === 1 && pol[i + 1] === -1 && ns < half) buf[half + ns++] = gw;
  }
  if (nb < 10 || ns < 10) return 0;
  const qb = quantile(buf, nb, 0.3);
  const qs = quantile(buf.subarray(half), ns, 0.3);
  return qb - qs;
}

function quantile(arr, n, q) {
  const a = Array.from(arr.subarray(0, n)).sort((x, y) => x - y);
  return a[Math.min(n - 1, Math.floor(q * n))];
}

// Max (or min) of src over the centred window [x-hw, x+hw] — O(n) monotonic deque.
function slidingExtreme(src, n, hw, out, dq, isMax) {
  let head = 0;
  let tail = 0;
  let next = 0;
  for (let x = 0; x < n; x++) {
    const hi = Math.min(n - 1, x + hw);
    for (; next <= hi; next++) {
      const v = src[next];
      while (tail > head && (isMax ? src[dq[tail - 1]] <= v : src[dq[tail - 1]] >= v)) tail--;
      dq[tail++] = next;
    }
    while (dq[head] < x - hw) head++;
    out[x] = src[dq[head]];
  }
}
