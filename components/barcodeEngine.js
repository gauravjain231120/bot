// Main-thread side of barcode decoding: grabs a camera frame turned to the
// requested angle (scanDraw.drawTurnedCrop) and hands it to the decoder in a
// Web Worker (barcodeWorker.js), so the heavy work never freezes the camera
// preview. If the worker can't start or stops answering, the same decoder
// (barcodeDecode.js) runs here on the main thread instead — slower, but it
// still scans. Shared by BarcodeScanner and the OCR scanners (which also
// look for the barcode printed under the id).
import { drawTurnedCrop } from './scanDraw';
import { createFrameDecoder } from './barcodeDecode';

// Straight and sideways first (how labels are nearly always held), then the
// diagonals, then the rest in 15° steps. Each scan line averages a few rows,
// which tolerates the remaining ±7.5° of tilt. A 1D read works both ways
// round, so 0-165° covers every direction.
export const BARCODE_ANGLES = [0, 90, 45, 135, 15, 165, 30, 150, 60, 120, 75, 105];

const WORKER_TIMEOUT_MS = 4000;
// The first answer also waits for the worker to start and load the decoder —
// on a slow phone that alone can take several seconds, and timing it out
// moved decoding onto the main thread for good (a janky preview).
const WORKER_FIRST_TIMEOUT_MS = 15000;

export function createBarcodeEngine() {
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  let worker = null;
  let inline = null;
  let pending = null; // { id, resolve, timer }
  let nextId = 1;
  let answered = false; // the worker has answered at least once

  function useInline() {
    if (worker) {
      worker.terminate();
      worker = null;
    }
    if (!inline) inline = createFrameDecoder();
  }

  function settle(id, result) {
    if (!pending || pending.id !== id) return;
    clearTimeout(pending.timer);
    const { resolve } = pending;
    pending = null;
    resolve(result);
  }

  try {
    worker = new Worker(new URL('./barcodeWorker.js', import.meta.url));
    worker.onmessage = (e) => {
      answered = true;
      settle(e.data.id, e.data.result);
    };
    worker.onerror = () => {
      const p = pending;
      useInline();
      if (p) settle(p.id, null);
    };
  } catch {
    useInline();
  }

  /** Decode the video's current frame turned by `angle`. Resolves {text, format} or null. */
  function decode(video, angle) {
    const img = drawTurnedCrop(video, canvas, ctx, angle);
    if (!worker) {
      if (!inline) inline = createFrameDecoder();
      try {
        return Promise.resolve(inline(img.data, img.width, img.height));
      } catch {
        return Promise.resolve(null);
      }
    }
    // One frame at a time: a call while one is still out answers that one
    // "nothing" rather than leaving its caller waiting forever.
    if (pending) settle(pending.id, null);
    return new Promise((resolve) => {
      const id = nextId++;
      const timer = setTimeout(() => {
        // Worker hung (or was never really running) — carry on without it.
        useInline();
        settle(id, null);
      }, answered ? WORKER_TIMEOUT_MS : WORKER_FIRST_TIMEOUT_MS);
      pending = { id, resolve, timer };
      const buf = img.data.buffer;
      worker.postMessage({ id, buf, w: img.width, h: img.height }, [buf]);
    });
  }

  function destroy() {
    if (pending) settle(pending.id, null);
    if (worker) worker.terminate();
    worker = null;
  }

  return { decode, destroy };
}
