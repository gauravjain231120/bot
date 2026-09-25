'use client';

import { useEffect, useRef, useState } from 'react';
import { MultiFormatReader, BarcodeFormat, DecodeHintType, BinaryBitmap, HybridBinarizer, RGBLuminanceSource } from '@zxing/library';
import { useTorch, TorchButtons, lowLightHint } from './useTorch';
import { SoundButton } from './scanSound';
import { stretchGray, smoothAlongBars, createBarcodeConfirmer } from './scanImage';
import { drawTurnedCrop } from './scanDraw';

// Myntra/Amazon tracking barcodes are all 1D — restricting decode to these
// formats makes every attempt cheaper than zxing's default of trying all.
const FORMATS = [
  BarcodeFormat.CODE_128,
  BarcodeFormat.CODE_39,
  BarcodeFormat.EAN_13,
  BarcodeFormat.EAN_8,
  BarcodeFormat.UPC_A,
  BarcodeFormat.ITF,
];
const HINTS = new Map();
HINTS.set(DecodeHintType.POSSIBLE_FORMATS, FORMATS);
// Note: TRY_HARDER is deliberately DISABLED. While it scans more rows, it burns
// massive amounts of CPU on mobile devices and drops the camera frame rate. 
// Instead of scanning 10 rows in one slow frame, we scan 1 row across 10 fast 
// frames (relying on natural hand jitter to find a clean row). This keeps the 
// video buttery smooth and prevents the phone from overheating.
// HINTS.set(DecodeHintType.TRY_HARDER, true);
const NATIVE_FORMATS = ['code_128', 'code_39', 'ean_13', 'ean_8', 'upc_a', 'itf'];

// PLAN ORDER: Prioritize the most common angles FIRST (straight, sideways, and perfect diagonals)
// with the raw image. If the barcode is well-printed, it scans instantly at any normal angle.
// Then, try stretching the contrast for those same common angles (for faint prints).
// Finally, check the odd angles, and only at the very end apply the expensive 'smooth' cleanup.
const PRIORITY_ANGLES = [0, 90, 45, 135];
const OTHER_ANGLES = [15, 165, 30, 150, 60, 120, 75, 105];
const PLAN = [];

// 1. Raw fast-pass on common angles (4 steps)
for (const angle of PRIORITY_ANGLES) PLAN.push({ angle, cleanup: 'raw' });
// 2. Faint-print pass on common angles (4 steps)
for (const angle of PRIORITY_ANGLES) PLAN.push({ angle, cleanup: 'stretch' });
// 3. Raw pass on odd angles (8 steps)
for (const angle of OTHER_ANGLES) PLAN.push({ angle, cleanup: 'raw' });
// 4. Faint-print pass on odd angles (8 steps)
for (const angle of OTHER_ANGLES) PLAN.push({ angle, cleanup: 'stretch' });
// 5. Deep smoothing for noisy/terrible prints (12 steps)
for (const angle of [...PRIORITY_ANGLES, ...OTHER_ANGLES]) PLAN.push({ angle, cleanup: 'smooth' });

// Keep the time budget very tight (30ms). This guarantees the JS thread yields
// quickly so the browser can paint the next camera frame. A high frame rate (30fps+)
// is critical for perceived speed and allows natural hand movement to act as our "TRY_HARDER".
const FRAME_BUDGET_MS = 30;
const TICK_MS = 30;

function luminance(img) {
  const n = img.width * img.height;
  const lum = new Uint8ClampedArray(n);
  const d = img.data;
  for (let i = 0, p = 0; i < n; i++, p += 4) lum[i] = (d[p] * 77 + d[p + 1] * 150 + d[p + 2] * 29) >> 8;
  return lum;
}

// Single binarizer strategy (HybridBinarizer). Doing multiple binarizers per step
// doubles CPU usage and slows down the frame loop too much. Hybrid is the best
// for uneven lighting / shadows on plastic packaging.
function tryZxing(reader, img) {
  const lum = luminance(img);
  try {
    const src = new RGBLuminanceSource(lum, img.width, img.height);
    const result = reader.decode(new BinaryBitmap(new HybridBinarizer(src)), HINTS);
    return result ? { text: result.getText(), format: BarcodeFormat[result.getBarcodeFormat()] } : null;
  } catch {
    return null;
  }
}

async function makeNativeDetector() {
  try {
    if (typeof window === 'undefined' || !('BarcodeDetector' in window)) return null;
    const supported = await window.BarcodeDetector.getSupportedFormats();
    const formats = NATIVE_FORMATS.filter((f) => supported.includes(f));
    return formats.length ? new window.BarcodeDetector({ formats }) : null;
  } catch {
    return null;
  }
}

/**
 * Full-screen camera barcode scanner — rear camera preferred automatically,
 * scans until a code is found or the user cancels.
 */
export function BarcodeScanner({ onDetected, onClose }) {
  const videoRef = useRef(null);
  const onDetectedRef = useRef(onDetected);
  const [error, setError] = useState(null);
  const torch = useTorch(videoRef);
  const attachTorch = torch.attach;

  useEffect(() => {
    onDetectedRef.current = onDetected;
  }, [onDetected]);

  useEffect(() => {
    let cancelled = false;
    let stream = null;
    let timer = null;
    let done = false;
    const reader = new MultiFormatReader();
    reader.setHints(HINTS);
    const confirm = createBarcodeConfirmer();
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    let native = null;
    let step = 0;

    function stop() {
      if (timer) clearTimeout(timer);
      timer = null;
      if (stream) {
        stream.getTracks().forEach((t) => t.stop());
        stream = null;
      }
    }

    function found(text, format) {
      const ok = confirm(text, format);
      if (!ok || done) return false;
      done = true;
      stop();
      onDetectedRef.current(ok);
      return true;
    }

    async function frame() {
      const video = videoRef.current;
      if (cancelled || done) return;
      if (video && video.videoWidth) {
        const t0 = performance.now();
        // 1. Native detector
        if (native) {
          try {
            const codes = await native.detect(video);
            for (const c of codes) if (found(c.rawValue, c.format)) return;
          } catch {
            native = null;
          }
        }
        // 2. ZXing Plan
        do {
          const { angle, cleanup } = PLAN[step];
          step = (step + 1) % PLAN.length;
          let img = drawTurnedCrop(video, canvas, ctx, angle);
          if (cleanup === 'stretch') img = stretchGray(img);
          else if (cleanup === 'smooth') img = stretchGray(smoothAlongBars(img, 4));
          
          const r = tryZxing(reader, img);
          if (r && found(r.text, r.format)) return;
          
          if (native && cleanup !== 'raw') {
            try {
              ctx.putImageData(img, 0, 0);
              const codes = await native.detect(canvas);
              for (const c of codes) if (found(c.rawValue, c.format)) return;
            } catch {}
          }
        } while (performance.now() - t0 < FRAME_BUDGET_MS && step !== 0);
      }
      timer = setTimeout(frame, TICK_MS);
    }

    async function start() {
      try {
        native = await makeNativeDetector();
        stream = await navigator.mediaDevices.getUserMedia({
          video: {
            facingMode: { ideal: 'environment' },
            width: { ideal: 1920 },
            height: { ideal: 1080 },
            advanced: [{ focusMode: 'continuous' }],
          },
        });
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }

        const video = videoRef.current;
        video.srcObject = stream;
        await video.play();

        attachTorch(stream.getVideoTracks()[0]);
        frame();
      } catch (e) {
        if (cancelled) return;
        const msg = e instanceof Error ? e.message : 'Could not start the camera.';
        setError(/permission|denied/i.test(msg) ? 'Camera permission denied — allow camera access and try again.' : msg);
      }
    }

    start();

    return () => {
      cancelled = true;
      stop();
    };
  }, [attachTorch]);


  return (
    <div
      style={{
        position: 'fixed', inset: 0, zIndex: 100, display: 'flex', flexDirection: 'column', background: '#000',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8, padding: 16 }}>
        <span style={{ color: '#fff', fontSize: '0.9rem', fontWeight: 600 }}>Scan barcode</span>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginLeft: 'auto' }}>
          <TorchButtons torch={torch} />
          <SoundButton />
          <button type="button" onClick={onClose} aria-label="Close scanner">
            ✕
          </button>
        </div>
      </div>
      <div style={{ position: 'relative', flex: 1, overflow: 'hidden' }}>
        <video
          ref={videoRef}
          muted
          playsInline
          style={{ height: '100%', width: '100%', objectFit: 'cover' }}
        />
        <div
          style={{
            position: 'absolute', left: 32, right: 32, top: '50%', height: 96, transform: 'translateY(-50%)',
            border: '2px solid rgba(255,255,255,0.7)', borderRadius: 8, pointerEvents: 'none',
          }}
        />
      </div>
      <div style={{ padding: 16, textAlign: 'center', fontSize: '0.78rem', color: 'rgba(255,255,255,0.7)' }}>
        {error ?? lowLightHint(torch) ?? 'Point the camera at the tracking barcode — any angle, faint print is fine. Hold still for a moment.'}
      </div>
    </div>
  );
}
