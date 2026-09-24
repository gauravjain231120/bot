'use client';

import { useEffect, useRef, useState } from 'react';
import { useTorch, TorchButtons, lowLightHint } from './useTorch';
import { stretchGray, estimateSkew, readOrderId, orderIdConfidence, createOrderIdVoter } from './scanImage';
import { drawBand } from './scanDraw';

// Amazon order ids are printed on labels/invoices as text, not a barcode, so
// BarcodeScanner can't read them — this reads the printed digits with OCR
// (tesseract.js, loaded only when this opens; its first use downloads the
// engine + English data, a few MB, then the browser caches it).
//
// Each camera frame (measured offline on 128 generated labels — PROJECT.md
// §34 — old method read 9/32 normal and 13/32 faint prints correctly, and
// only 2/24 tilted 7°; this reads 31/32, 32/32 and 24/24):
//   1. the middle band (the guide box) is contrast-stretched, so faint grey
//      digits become black (scanImage.stretchGray);
//   2. its tilt is measured (scanImage.estimateSkew, ±12°) and the band is
//      re-drawn straightened — tilt, not faintness, was the main reason reads
//      failed;
//   3. the text reader runs on it, digits only.
// If a frame finds nothing, the next one is tried upside down (a label held
// the other way up), and so on alternately.
//
// Misreads are the real risk, so a read only counts once it's trustworthy
// (scanImage.createOrderIdVoter): the same 3-7-7 id read 3 times in the last
// 6 frames, or twice with high per-digit confidence from two different
// clean-ups (normal size / 1.5x). In the offline run that accepted 121 of 128
// labels and never a wrong id. Only a 3-7-7 digit group on ONE line with no
// digit touching it counts, so tracking numbers, pin codes and dates are ignored.
const PAUSE_MS = 60;

/**
 * Full-screen camera reader for a printed Amazon order id. Calls
 * onDetected('###-#######-#######') once confident.
 */
export function OrderIdScanner({ onDetected, onClose }) {
  const videoRef = useRef(null);
  const onDetectedRef = useRef(onDetected);
  const [status, setStatus] = useState('Starting camera…');
  const [error, setError] = useState(null);
  const [lastSeen, setLastSeen] = useState(null);
  // Flashlight: manual 🔦 + auto flash in low light (components/useTorch.js).
  const torch = useTorch(videoRef);
  const attachTorch = torch.attach;

  useEffect(() => {
    onDetectedRef.current = onDetected;
  }, [onDetected]);

  useEffect(() => {
    let cancelled = false;
    let stream = null;
    let worker = null;
    let timer = null;
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    const vote = createOrderIdVoter();
    let frameNo = 0;
    let upsideDown = false;

    function stop() {
      if (timer) clearTimeout(timer);
      timer = null;
      if (stream) {
        stream.getTracks().forEach((t) => t.stop());
        stream = null;
      }
      if (worker) {
        worker.terminate().catch(() => {});
        worker = null;
      }
    }

    async function readOneFrame() {
      const video = videoRef.current;
      if (cancelled || !worker || !video || !video.videoWidth) return;
      const base = upsideDown ? 180 : 0;
      // Measure the tilt on a cleaned-up band, then re-draw it straightened.
      const skew = estimateSkew(stretchGray(drawBand(video, canvas, ctx, base, 1)));
      const variant = frameNo++ % 2 === 0 ? 'A' : 'B';
      const img = stretchGray(drawBand(video, canvas, ctx, base - skew, variant === 'B' ? 1.5 : 1));
      ctx.putImageData(img, 0, 0);
      const { data } = await worker.recognize(canvas, {}, { text: true, blocks: true });
      if (cancelled) return;
      const id = readOrderId(data && data.text);
      if (!id) {
        upsideDown = !upsideDown; // nothing here — try the other way up next
        return;
      }
      setLastSeen(id);
      const accepted = vote({ id, confidence: orderIdConfidence(data, id) ?? 0, variant });
      if (accepted) {
        stop();
        onDetectedRef.current(accepted);
      }
    }

    async function loop() {
      try {
        await readOneFrame();
      } catch {
        // One bad frame — try the next.
      }
      if (!cancelled && worker) timer = setTimeout(loop, PAUSE_MS);
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
        attachTorch(stream.getVideoTracks()[0]);
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

      setStatus('Hold the order ID inside the box — any way up, faint print is fine');
      loop();
    }

    start();
    return () => {
      cancelled = true;
      stop();
    };
  }, [attachTorch]);


  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 100, display: 'flex', flexDirection: 'column', background: '#000' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8, padding: 16 }}>
        <span style={{ color: '#fff', fontSize: '0.9rem', fontWeight: 600 }}>Read order ID</span>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginLeft: 'auto' }}>
          <TorchButtons torch={torch} />
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
            {lowLightHint(torch) && <div style={{ marginTop: 4, color: '#fbbf24' }}>{lowLightHint(torch)}</div>}
            {lastSeen && <div style={{ marginTop: 4, fontFamily: 'monospace', color: '#fff' }}>Reading: {lastSeen}… hold still, checking it</div>}
          </>
        )}
      </div>
    </div>
  );
}
