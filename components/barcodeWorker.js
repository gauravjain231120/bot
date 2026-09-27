// Web Worker: decodes camera frames off the main thread (see barcodeDecode.js
// and barcodeEngine.js). In: { id, buf: ArrayBuffer (RGBA), w, h } — the
// buffer is transferred, not copied. Out: { id, result: {text, format} | null }.
import { createFrameDecoder } from './barcodeDecode';

const decode = createFrameDecoder();

self.onmessage = (e) => {
  const { id, buf, w, h } = e.data;
  let result = null;
  try {
    result = decode(new Uint8ClampedArray(buf), w, h);
  } catch {
    // a bad frame — the next one is tried
  }
  self.postMessage({ id, result });
};
