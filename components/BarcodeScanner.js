'use client';

import { useEffect, useRef, useState } from 'react';
import { useTorch, TorchButtons, lowLightHint } from './useTorch';
import { SoundButton } from './scanSound';
import { createBarcodeConfirmer, looksLikeId } from './scanImage';
import { createBarcodeEngine, BARCODE_ANGLES } from './barcodeEngine';

// Per camera frame (full write-up: PROJECT.md §36):
//  1. the phone's own reader (BarcodeDetector — Android Chrome) when there
//     is one: fast, any angle;
//  2. our decoder, in a Web Worker so the preview never stutters
//     (barcodeEngine → barcodeWorker → barcodeDecode → barcodeLines): the
//     frame turned to the next angle in BARCODE_ANGLES, rebuilt as clean
//     scan lines from bar EDGES (not one grey threshold — that's what made
//     faint / light prints unreadable), incl. versions with hairline white
//     streaks in the bars closed up.
// A read must pass createBarcodeConfirmer (looks like a real id; anything but
// a Myntra MY… id read twice). After a first, unconfirmed read the same
// angle is kept for a few frames so the confirming read comes quickly.
const NATIVE_FORMATS = ['code_128', 'code_39', 'ean_13', 'ean_8', 'upc_a', 'itf'];
const HOLD_FRAMES = 4;

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
    let done = false;
    let native = null;
    const confirm = createBarcodeConfirmer();
    const engine = createBarcodeEngine();

    function stop() {
      if (stream) {
        stream.getTracks().forEach((t) => t.stop());
        stream = null;
      }
      engine.destroy();
    }

    function found(text, format) {
      const ok = confirm(text, format);
      if (!ok || done) return false;
      done = true;
      stop();
      onDetectedRef.current(ok);
      return true;
    }

    // Lets the browser paint a frame between decode attempts.
    const nextFrame = () => new Promise((r) => (typeof requestAnimationFrame === 'function' ? requestAnimationFrame(() => r()) : setTimeout(r, 16)));

    async function loop() {
      let step = 0;
      let hold = 0;
      while (!cancelled && !done) {
        const video = videoRef.current;
        if (!video || !video.videoWidth) {
          await nextFrame();
          continue;
        }
        if (native) {
          try {
            const codes = await native.detect(video);
            for (const c of codes) if (found(c.rawValue, c.format)) return;
          } catch {
            native = null;
          }
        }
        if (cancelled || done) return;
        const r = await engine.decode(video, BARCODE_ANGLES[step]);
        if (cancelled || done) return;
        if (r) {
          if (found(r.text, r.format)) return;
          if (looksLikeId(r.text)) hold = HOLD_FRAMES; // read once — look again at this angle to confirm
        }
        if (hold > 0) hold--;
        else step = (step + 1) % BARCODE_ANGLES.length;
        await nextFrame();
      }
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
          stop();
          return;
        }

        const video = videoRef.current;
        video.srcObject = stream;
        await video.play();

        attachTorch(stream.getVideoTracks()[0]);
        loop();
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
        {error ?? lowLightHint(torch) ?? 'Point the camera at the tracking barcode — any angle. Faint print? Move closer so the barcode fills the screen width, and hold still.'}
      </div>
    </div>
  );
}
