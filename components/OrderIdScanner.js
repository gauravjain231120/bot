'use client';

import { useEffect, useRef, useState } from 'react';

// Amazon order ids are printed on labels/invoices as text, not a barcode, so
// BarcodeScanner can't read them — this reads the printed digits with OCR
// (tesseract.js, loaded only when this opens; its first use downloads the
// engine + English data, a few MB, then the browser caches it).
//
// Misreads are the real risk with OCR, so a read only counts once:
//   1. it matches the Amazon order-id shape 3-7-7 digits, and
//   2. the SAME order id comes out of two frames in a row.
// Anything else on the label (tracking numbers, pin codes, phone numbers) has
// a different digit pattern and is ignored.
const ORDER_ID_RE = /(\d{3})[\s\-–—]*(\d{7})[\s\-–—]*(\d{7})/;
const TICK_MS = 700;

function readOrderId(text) {
  const m = String(text || '').replace(/[Oo]/g, '0').match(ORDER_ID_RE);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
}

// Crop the middle band of the frame (where the on-screen guide box is),
// scale it up 2x and grey/contrast it — small printed text OCRs much better
// larger and flattened to black-on-white.
function drawBand(video, canvas) {
  const vw = video.videoWidth;
  const vh = video.videoHeight;
  const sw = Math.round(vw * 0.9);
  const sh = Math.round(vh * 0.3);
  const sx = Math.round((vw - sw) / 2);
  const sy = Math.round((vh - sh) / 2);
  canvas.width = sw * 2;
  canvas.height = sh * 2;
  const ctx = canvas.getContext('2d');
  ctx.filter = 'grayscale(1) contrast(1.6) brightness(1.1)';
  ctx.drawImage(video, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
}

/**
 * Full-screen camera reader for a printed Amazon order id. Calls
 * onDetected('###-#######-#######') once confident; the caller shows it in the
 * input so it can still be checked before searching.
 */
export function OrderIdScanner({ onDetected, onClose }) {
  const videoRef = useRef(null);
  const trackRef = useRef(null);
  const onDetectedRef = useRef(onDetected);
  const [status, setStatus] = useState('Starting camera…');
  const [error, setError] = useState(null);
  const [lastSeen, setLastSeen] = useState(null);
  const [torchSupported, setTorchSupported] = useState(false);
  const [torchOn, setTorchOn] = useState(false);

  useEffect(() => {
    onDetectedRef.current = onDetected;
  }, [onDetected]);

  useEffect(() => {
    let cancelled = false;
    let stream = null;
    let worker = null;
    let intervalId = null;
    let busy = false;
    let previous = null;
    const canvas = document.createElement('canvas');

    function stop() {
      if (intervalId) clearInterval(intervalId);
      intervalId = null;
      if (stream) {
        stream.getTracks().forEach((t) => t.stop());
        stream = null;
      }
      if (worker) {
        worker.terminate().catch(() => {});
        worker = null;
      }
    }

    async function start() {
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: {
            facingMode: { ideal: 'environment' },
            width: { ideal: 1920 },
            height: { ideal: 1080 },
            advanced: [{ focusMode: 'continuous' }],
          },
        });
        if (cancelled) return stop();
        const video = videoRef.current;
        video.srcObject = stream;
        await video.play();
        const track = stream.getVideoTracks()[0];
        trackRef.current = track;
        const caps = track.getCapabilities ? track.getCapabilities() : {};
        if (caps.torch) setTorchSupported(true);
      } catch (e) {
        if (cancelled) return;
        const msg = e instanceof Error ? e.message : 'Could not start the camera.';
        setError(/permission|denied/i.test(msg) ? 'Camera permission denied — allow camera access and try again.' : msg);
        return;
      }

      try {
        setStatus('Loading text reader… (first time takes a few seconds)');
        const { createWorker } = await import('tesseract.js');
        worker = await createWorker('eng');
        if (cancelled) return stop();
        await worker.setParameters({
          tessedit_char_whitelist: '0123456789-',
          tessedit_pageseg_mode: '6',
        });
      } catch (e) {
        if (cancelled) return;
        setError(`Couldn't load the text reader (${e && e.message ? e.message : 'network error'}). Type the order ID instead.`);
        return;
      }

      setStatus('Hold the order ID inside the box');
      intervalId = setInterval(async () => {
        const video = videoRef.current;
        if (busy || cancelled || !worker || !video || !video.videoWidth) return;
        busy = true;
        try {
          drawBand(video, canvas);
          const { data } = await worker.recognize(canvas);
          if (cancelled) return;
          const found = readOrderId(data && data.text);
          setLastSeen(found);
          if (found && found === previous) {
            stop();
            onDetectedRef.current(found);
            return;
          }
          previous = found;
        } catch {
          // One bad frame — try the next.
        } finally {
          busy = false;
        }
      }, TICK_MS);
    }

    start();
    return () => {
      cancelled = true;
      stop();
    };
  }, []);

  async function toggleTorch() {
    if (!trackRef.current) return;
    const next = !torchOn;
    try {
      await trackRef.current.applyConstraints({ advanced: [{ torch: next }] });
      setTorchOn(next);
    } catch {
      // Torch reported but rejected at runtime — leave it as it was.
    }
  }

  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 100, display: 'flex', flexDirection: 'column', background: '#000' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: 16 }}>
        <span style={{ color: '#fff', fontSize: '0.9rem', fontWeight: 600 }}>Read order ID</span>
        <div style={{ display: 'flex', gap: 8 }}>
          {torchSupported && (
            <button type="button" onClick={toggleTorch} aria-label={torchOn ? 'Turn off flashlight' : 'Turn on flashlight'}>
              {torchOn ? '🔦 On' : '🔦 Off'}
            </button>
          )}
          <button type="button" onClick={onClose} aria-label="Close scanner">✕</button>
        </div>
      </div>
      <div style={{ position: 'relative', flex: 1, overflow: 'hidden' }}>
        <video ref={videoRef} muted playsInline style={{ height: '100%', width: '100%', objectFit: 'contain' }} />
        <div
          style={{
            position: 'absolute', left: '5%', right: '5%', top: '35%', height: '30%',
            border: '2px solid rgba(255,255,255,0.7)', borderRadius: 8, pointerEvents: 'none',
          }}
        />
      </div>
      <div style={{ padding: 16, textAlign: 'center', fontSize: '0.8rem', color: 'rgba(255,255,255,0.75)' }}>
        {error ?? (
          <>
            {status}
            {lastSeen && <div style={{ marginTop: 4, fontFamily: 'monospace', color: '#fff' }}>Reading: {lastSeen}… hold still</div>}
          </>
        )}
      </div>
    </div>
  );
}
