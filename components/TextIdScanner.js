'use client';

import { useEffect, useRef, useState } from 'react';
import { useTorch, TorchButtons, lowLightHint } from './useTorch';
import { SoundButton } from './scanSound';
import { stretchGray, estimateSkew, createIdVoter, createBarcodeConfirmer } from './scanImage';
import { drawBand } from './scanDraw';
import { createBarcodeEngine, BARCODE_ANGLES } from './barcodeEngine';

// Camera reader for an id PRINTED as text — the Amazon order id
// (OrderIdScanner) or the Myntra tracking id (MyntraTextScanner). Two readers
// run side by side on the same camera:
//
// 1. Barcode (barcodeEngine, in a Web Worker): a Myntra label prints the
//    tracking barcode right under the text, and a barcode read is exact
//    (check character) where OCR can take a 0 for an 8. So if any barcode in
//    view decodes to an id of the right shape (`fromBarcode`), it wins at
//    once.
// 2. Text (tesseract.js, loaded only when this opens; its first use downloads
//    the engine + English data, a few MB, then the browser caches it). Per
//    frame: the guide-box band is contrast-stretched (faint grey ink becomes
//    black — scanImage.stretchGray), its tilt measured (estimateSkew, ±12°)
//    and the band redrawn straight; frames alternate normal / 1.5x size, and
//    a frame that finds nothing is tried upside down next. `readId` pulls the
//    id out of the text (strict shape, one line at a time).
//    OCR ids only count via scanImage.createIdVoter: 3 identical reads from
//    both sizes, and NO read in the last 8 differing by a digit or two. When
//    frames disagree (0 vs 8) the scanner shows both and keeps looking —
//    it never guesses.
const PAUSE_MS = 60;

/**
 * @param {object} p
 * @param {string} p.title            header, e.g. "Read order ID"
 * @param {string} p.hint             status line while reading
 * @param {string} p.whitelist        tesseract character whitelist
 * @param {(text: string) => string|null} p.readId       id from OCR text
 * @param {(text: string) => string|null} p.fromBarcode  id from a barcode's text (null = not this kind of id)
 * @param {(id: string) => void} p.onDetected
 * @param {() => void} p.onClose
 */
export function TextIdScanner({ title, hint, whitelist, readId, fromBarcode, onDetected, onClose }) {
  const videoRef = useRef(null);
  const onDetectedRef = useRef(onDetected);
  const configRef = useRef({ whitelist, readId, fromBarcode, hint });
  const [status, setStatus] = useState('Starting camera…');
  const [error, setError] = useState(null);
  const [lastSeen, setLastSeen] = useState(null);
  const [rival, setRival] = useState(null);
  // Flashlight: manual 🔦 + auto flash in low light (components/useTorch.js).
  const torch = useTorch(videoRef);
  const attachTorch = torch.attach;

  useEffect(() => {
    onDetectedRef.current = onDetected;
    configRef.current = { whitelist, readId, fromBarcode, hint };
  }, [onDetected, whitelist, readId, fromBarcode, hint]);

  useEffect(() => {
    let cancelled = false;
    let done = false;
    let stream = null;
    let worker = null;
    let timer = null;
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    const vote = createIdVoter();
    const confirmBarcode = createBarcodeConfirmer();
    const engine = createBarcodeEngine();
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
      engine.destroy();
    }

    function accept(id) {
      if (done) return;
      done = true;
      stop();
      onDetectedRef.current(id);
    }

    // ---- 1. barcode, alongside the OCR ----
    async function barcodeLoop() {
      let step = 0;
      let hold = 0;
      while (!cancelled && !done) {
        const video = videoRef.current;
        if (video && video.videoWidth) {
          const r = await engine.decode(video, BARCODE_ANGLES[step]);
          if (cancelled || done) return;
          // Other barcodes on the label (e.g. an Amazon tracking number) are
          // simply not this kind of id and are ignored.
          const candidate = r && configRef.current.fromBarcode(r.text);
          if (candidate) {
            if (confirmBarcode(r.text, r.format)) return accept(candidate);
            hold = 4; // first read — look again at this angle to confirm it
          }
          if (hold > 0) hold--;
          else step = (step + 1) % BARCODE_ANGLES.length;
        }
        await new Promise((res) => setTimeout(res, PAUSE_MS));
      }
    }

    // ---- 2. text ----
    async function readOneFrame() {
      const video = videoRef.current;
      if (cancelled || done || !worker || !video || !video.videoWidth) return;
      const base = upsideDown ? 180 : 0;
      // Measure the tilt on a cleaned-up band, then re-draw it straightened.
      const skew = estimateSkew(stretchGray(drawBand(video, canvas, ctx, base, 1)));
      const variant = frameNo++ % 2 === 0 ? 'A' : 'B';
      const img = stretchGray(drawBand(video, canvas, ctx, base - skew, variant === 'B' ? 1.5 : 1));
      ctx.putImageData(img, 0, 0);
      const { data } = await worker.recognize(canvas);
      if (cancelled || done) return;
      const id = configRef.current.readId(data && data.text);
      if (!id) {
        upsideDown = !upsideDown; // nothing here — try the other way up next
        return;
      }
      setLastSeen(id);
      const accepted = vote({ id, variant });
      setRival(vote.rival);
      if (accepted) accept(accepted);
    }

    async function ocrLoop() {
      try {
        await readOneFrame();
      } catch {
        // One bad frame — try the next.
      }
      if (!cancelled && !done && worker) timer = setTimeout(ocrLoop, PAUSE_MS);
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

      barcodeLoop();

      try {
        setStatus('Loading text reader… (first time takes a few seconds)');
        const { createWorker } = await import('tesseract.js');
        const w = await createWorker('eng');
        if (cancelled || done) {
          w.terminate().catch(() => {});
          return;
        }
        worker = w;
        await worker.setParameters({
          tessedit_char_whitelist: configRef.current.whitelist,
          tessedit_pageseg_mode: '6',
        });
      } catch (e) {
        if (cancelled || done) return;
        setError(`Couldn't load the text reader (${e && e.message ? e.message : 'network error'}). Type it in instead.`);
        return;
      }

      setStatus(configRef.current.hint);
      ocrLoop();
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
        <span style={{ color: '#fff', fontSize: '0.9rem', fontWeight: 600 }}>{title}</span>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginLeft: 'auto' }}>
          <TorchButtons torch={torch} />
          <SoundButton />
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
            {rival && lastSeen ? (
              <div style={{ marginTop: 4, fontFamily: 'monospace', color: '#fbbf24' }}>
                Unsure: {lastSeen} or {rival}? Move closer / hold steadier
              </div>
            ) : (
              lastSeen && <div style={{ marginTop: 4, fontFamily: 'monospace', color: '#fff' }}>Reading: {lastSeen}… hold still, checking it</div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
