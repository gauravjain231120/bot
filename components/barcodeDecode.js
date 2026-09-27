// One camera frame (RGBA, already turned) → barcode text, via the clean scan
// lines of barcodeLines.js and zxing's 1D readers. DOM-free — the scanner
// runs it in a Web Worker (barcodeWorker.js) so the camera preview never
// stutters, and offline tests run the same code.
import {
  BarcodeFormat,
  BinaryBitmap,
  DecodeHintType,
  GlobalHistogramBinarizer,
  MultiFormatOneDReader,
  RGBLuminanceSource,
} from '@zxing/library';
import { scanLines } from './barcodeLines';

// Shipping labels (Myntra MY…, Amazon/courier tracking) are Code 128; Code 39
// is kept for the odd courier label. Fewer formats = faster, and fewer
// chances for a random line to decode as garbage. (The phone's own
// BarcodeDetector, when present, still covers everything else.)
const FORMATS = [BarcodeFormat.CODE_128, BarcodeFormat.CODE_39];

export function createFrameDecoder(lineOpts) {
  const hints = new Map();
  hints.set(DecodeHintType.POSSIBLE_FORMATS, FORMATS);
  // Every scan line is tried (and read both ways round, so upside-down
  // labels work). The stack is only a few hundred short lines, so this is
  // cheap — unlike TRY_HARDER on a whole 1080p frame.
  hints.set(DecodeHintType.TRY_HARDER, true);
  // Used directly, not via MultiFormatReader: that one console.warn()s a
  // stack trace on every miss, i.e. many times a second while scanning.
  const reader = new MultiFormatOneDReader(hints);

  return function decode(rgba, w, h) {
    const n = w * h;
    const lum = new Uint8ClampedArray(n);
    for (let i = 0, p = 0; i < n; i++, p += 4) lum[i] = (rgba[p] * 77 + rgba[p + 1] * 150 + rgba[p + 2] * 29) >> 8;
    const st = scanLines(lum, w, h, lineOpts);
    if (!st.h) return null;
    try {
      const bitmap = new BinaryBitmap(new GlobalHistogramBinarizer(new RGBLuminanceSource(st.lum, st.w, st.h)));
      const r = reader.decode(bitmap, hints);
      return { text: r.getText(), format: BarcodeFormat[r.getBarcodeFormat()] };
    } catch {
      return null;
    }
  };
}
