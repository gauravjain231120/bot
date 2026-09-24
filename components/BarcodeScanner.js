'use client';

import { useEffect, useRef, useState } from 'react';
import { MultiFormatReader, BarcodeFormat, DecodeHintType, BinaryBitmap, HybridBinarizer, RGBLuminanceSource } from '@zxing/library';
import { useTorch, TorchButtons, lowLightHint } from './useTorch';
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
// TRY_HARDER: more scanlines per attempt, better tolerance for a faint or
// damaged edge — exactly what a lightly-printed label needs.
HINTS.set(DecodeHintType.TRY_HARDER, true);
const NATIVE_FORMATS = ['code_128', 'code_39', 'ean_13', 'ean_8', 'upc_a', 'itf'];

// How each camera frame is tried (measured offline on generated labels, see
// PROJECT.md §34 — old method: faint prints 0/15, tilted labels 3/15; this:
// faint 15/15 at every angle, very faint 13/15):
//
//  1. The phone's own barcode reader (BarcodeDetector — Android Chrome and
//     most Android browsers) when it exists: hardware-fast, reads any angle.
//  2. Otherwise / additionally zxing, on the frame turned to one of 12 angles
//     (every 15° over 180° — a 1D reader also reads upside down, so 180° covers
//     all 360°), each in three clean-ups:
//       raw     as the camera saw it
//       stretch contrast stretched to full black/white (faint ink → dark)
//       smooth  noise averaged out along the bars, then stretched (very faint)
//     Every frame gets a fixed time budget; the next frame carries on where
//     the last left off, so no single frame stalls and the common upright
//     case (tried first) still reads on the very first frame. The whole
//     frame is used (see scanDraw.js) — a vertical barcode runs outside the
//     guide box.
const ANGLES = [0, 90, 45, 135, 15, 165, 30, 150, 60, 120, 75, 105];
const CLEANUPS = ['raw', 'stretch', 'smooth'];
// Every angle plain first (a normal print at any angle reads within 12
// attempts), then every angle stretched, then smoothed — so the extra
// clean-ups only cost time on a print that actually needs them.
const PLAN = [];
for (const cleanup of CLEANUPS) for (const angle of ANGLES) PLAN.push({ angle, cleanup });
const FRAME_BUDGET_MS = 70;
const TICK_MS = 90;
function luminance(img) {
  const n = img.width * img.height;
  const lum = new Uint8ClampedArray(n);
  const d = img.data;
  for (let i = 0, p = 0; i < n; i++, p += 4) lum[i] = (d[p] * 77 + d[p + 1] * 150 + d[p + 2] * 29) >> 8;
  return lum;
}

function tryZxing(reader, img) {
  try {
    const result = reader.decode(new BinaryBitmap(new HybridBinarizer(new RGBLuminanceSource(luminance(img), img.width, img.height))), HINTS);
    return result ? { text: result.getText(), format: BarcodeFormat[result.getBarcodeFormat()] } : null;
  } catch {
    return null; // no code in this attempt — normal
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
 * scans until a code is found or the user cancels. Works on Android Chrome
 * and iOS Safari over HTTPS (Vercel's default) or localhost; `playsInline`
 * is required specifically for iOS — without it Safari forces its own native
 * fullscreen video player instead of showing the feed inside this overlay.
 *
 * Drives the camera and the capture loop itself (getUserMedia + its own
 * timer) so every frame can go through the reading plan above. A code only
 * counts once it's trustworthy (createBarcodeConfirmer: a check-digit format
 * on the first read, Code 39 / ITF — no check digit — only when the same text
 * comes out twice in a row).
 */
export function BarcodeScanner({ onDetected, onClose }) {
  const videoRef = useRef(null);
  const onDetectedRef = useRef(onDetected);
  const [error, setError] = useState(null);
  // Flashlight: manual 🔦 + auto flash in low light (components/useTorch.js).
  const torch = useTorch(videoRef);
  const attachTorch = torch.attach;

  // Refs must not be written during render — keep the latest callback synced
  // via its own effect instead.
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
    let step = 0; // where in PLAN the next frame carries on

    function stop() {
      if (timer) clearTimeout(timer);
      timer = null;
      if (stream) {
        // Stops the media stream (turns the camera light off) — without
        // this the browser keeps the camera "on" even after this unmounts.
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
        // 1. The phone's own reader (any angle, very fast).
        if (native) {
          try {
            const codes = await native.detect(video);
            for (const c of codes) if (found(c.rawValue, c.format)) return;
          } catch {
            native = null; // broken on this device — zxing only from now on
          }
        }
        // 2. zxing through the plan, within this frame's time budget.
        do {
          const { angle, cleanup } = PLAN[step];
          step = (step + 1) % PLAN.length;
          let img = drawTurnedCrop(video, canvas, ctx, angle);
          if (cleanup === 'stretch') img = stretchGray(img);
          else if (cleanup === 'smooth') img = stretchGray(smoothAlongBars(img, 4));
          const r = tryZxing(reader, img);
          if (r && found(r.text, r.format)) return;
          // Faint print on a phone with its own reader: let it look at the
          // cleaned-up picture too, it's far better at odd angles.
          if (native && cleanup !== 'raw') {
            try {
              ctx.putImageData(img, 0, 0);
              const codes = await native.detect(canvas);
              for (const c of codes) if (found(c.rawValue, c.format)) return;
            } catch {
              // ignore — zxing carries on
            }
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
            // Higher resolution resolves thin/faint bars; continuous
            // autofocus (where supported) keeps the label sharp without the
            // phone held at one exact distance.
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
    // Runs exactly once per mount — onDetected is read via a ref so a new
    // inline function passed in from the caller never restarts the camera
    // (attachTorch is a stable callback, it never changes either).
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
