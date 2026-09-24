'use client';

import { useEffect, useRef, useState } from 'react';
import { useTorch, TorchButtons, lowLightHint } from './useTorch';
import { BrowserMultiFormatReader } from '@zxing/browser';
import { BarcodeFormat, DecodeHintType } from '@zxing/library';

// Myntra tracking barcodes (and the label barcodes this is used for) are all
// 1D — restricting decode to just these formats (instead of zxing's default
// of trying every symbology it knows) means every attempt is cheaper to
// process, which is most of what made scanning feel slow.
const HINTS = new Map();
HINTS.set(DecodeHintType.POSSIBLE_FORMATS, [
  BarcodeFormat.CODE_128,
  BarcodeFormat.CODE_39,
  BarcodeFormat.EAN_13,
  BarcodeFormat.EAN_8,
  BarcodeFormat.UPC_A,
  BarcodeFormat.ITF,
]);
// TRY_HARDER makes each individual attempt more thorough — more scanlines,
// better tolerance for a partially faint/damaged edge — which is exactly
// what a lightly-printed label needs, worth the extra cost per attempt.
HINTS.set(DecodeHintType.TRY_HARDER, true);

// 1D readers decode along horizontal scanlines, so a barcode that's sideways
// or upside down relative to the frame just isn't found no matter how many
// times the same orientation is retried. Every capture is tried at all 4
// cardinal rotations (a real return label can end up any which way depending
// on how the courier stuck it on, or how the phone's held) — stops at the
// first one that decodes, so a normally-aligned scan (the common case) still
// resolves on the very first attempt, same speed as before.
const ROTATIONS = [0, 90, 180, 270];

// A light contrast/brightness boost applied to every captured frame before
// decoding — a faint/low-ink print is a real contrast problem a phone
// camera's own auto-exposure doesn't always compensate for; this is a cheap,
// GPU-accelerated way to widen the gap between bar and background before
// zxing's own adaptive thresholding (HybridBinarizer) runs on it.
const CANVAS_FILTER = 'contrast(1.4) brightness(1.15)';

function drawRotatedFrame(video, canvas, angleDeg) {
  const vw = video.videoWidth;
  const vh = video.videoHeight;
  if (angleDeg === 90 || angleDeg === 270) {
    canvas.width = vh;
    canvas.height = vw;
  } else {
    canvas.width = vw;
    canvas.height = vh;
  }
  const ctx = canvas.getContext('2d');
  ctx.filter = CANVAS_FILTER;
  ctx.save();
  ctx.translate(canvas.width / 2, canvas.height / 2);
  ctx.rotate((angleDeg * Math.PI) / 180);
  ctx.drawImage(video, -vw / 2, -vh / 2, vw, vh);
  ctx.restore();
}

/**
 * Full-screen camera barcode scanner — rear camera preferred automatically,
 * scans until a code is found or the user cancels. Works on Android Chrome
 * and iOS Safari over HTTPS (Vercel's default) or localhost; `playsInline`
 * is required specifically for iOS — without it Safari forces its own native
 * fullscreen video player instead of showing the feed inside this overlay.
 *
 * Drives the camera and the capture loop directly (getUserMedia + its own
 * `setInterval`, not @zxing/browser's decodeFromConstraints) instead of the
 * simpler continuous-video-decode helper, specifically so every captured
 * frame can be tried at 4 rotations with a contrast boost first — see
 * ROTATIONS/CANVAS_FILTER above. Same component as stock-manager's own
 * BarcodeScanner.tsx, ported to plain JS/JSX to match this project's
 * convention (no TypeScript here).
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
    let intervalId = null;
    let busy = false;
    const reader = new BrowserMultiFormatReader(HINTS);
    const canvas = document.createElement('canvas');

    function stop() {
      if (intervalId) clearInterval(intervalId);
      intervalId = null;
      if (stream) {
        // Stops the media stream (turns the camera light off) — without
        // this the browser keeps the camera "on" even after this unmounts.
        stream.getTracks().forEach((t) => t.stop());
        stream = null;
      }
    }

    async function start() {
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: {
            facingMode: { ideal: 'environment' },
            // Higher resolution helps small/far-away barcodes resolve;
            // continuous autofocus (where supported) keeps the barcode
            // sharp without the user holding the phone at one exact
            // distance.
            width: { ideal: 1280 },
            height: { ideal: 720 },
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

        // 120ms (not the earlier 75ms) — each tick now tries up to 4
        // rotations instead of 1, so this keeps typical CPU load similar
        // while still resolving in well under half a second either way.
        // `busy` skips a tick outright rather than letting attempts queue
        // up if a capture ever takes longer than the interval.
        intervalId = setInterval(() => {
          if (busy || cancelled || !video.videoWidth) return;
          busy = true;
          for (const angle of ROTATIONS) {
            drawRotatedFrame(video, canvas, angle);
            try {
              const result = reader.decodeFromCanvas(canvas);
              if (result) {
                stop();
                onDetectedRef.current(result.getText());
                return;
              }
            } catch {
              // No code at this rotation — normal, try the next one.
            }
          }
          busy = false;
        }, 120);
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
        {error ?? lowLightHint(torch) ?? 'Point the camera at the tracking barcode — any angle works. Faint print? Try the flashlight.'}
      </div>
    </div>
  );
}
