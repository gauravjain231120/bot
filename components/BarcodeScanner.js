'use client';

import { useEffect, useRef, useState } from 'react';
import { BrowserMultiFormatReader } from '@zxing/browser';
import { BarcodeFormat, DecodeHintType } from '@zxing/library';

// Myntra tracking barcodes (and the label barcodes this is used for) are all
// 1D — restricting decode to just these formats (instead of zxing's default
// of trying every symbology it knows) means every video frame is cheaper to
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
// TRY_HARDER costs a bit more per frame but catches codes that are slightly
// blurry, tilted or partially out of focus — worth it once decode attempts
// are already fast and frequent (see delayBetweenScanAttempts below).
HINTS.set(DecodeHintType.TRY_HARDER, true);

/**
 * Full-screen camera barcode scanner — rear camera preferred automatically
 * (no deviceId given), continuous decode until a code is found or the user
 * cancels. Works on Android Chrome and iOS Safari over HTTPS (Vercel's
 * default) or localhost; `playsInline` is required specifically for iOS —
 * without it Safari forces its own native fullscreen video player instead of
 * showing the feed inside this overlay. Same component as stock-manager's
 * own BarcodeScanner.tsx, ported to plain JS/JSX to match this project's
 * convention (no TypeScript here).
 */
export function BarcodeScanner({ onDetected, onClose }) {
  const videoRef = useRef(null);
  const controlsRef = useRef(null);
  const onDetectedRef = useRef(onDetected);
  const [error, setError] = useState(null);

  // Refs must not be written during render — keep the latest callback synced
  // via its own effect instead.
  useEffect(() => {
    onDetectedRef.current = onDetected;
  }, [onDetected]);

  useEffect(() => {
    // Default is 500ms between decode attempts (~2 frames/sec) — that gap is
    // what made scanning feel laggy. 75ms (~13 frames/sec) is still light
    // enough for a phone to sustain and makes the scanner feel near-instant.
    const reader = new BrowserMultiFormatReader(HINTS, {
      delayBetweenScanAttempts: 75,
      delayBetweenScanSuccess: 500,
    });
    let cancelled = false;

    const constraints = {
      video: {
        facingMode: { ideal: 'environment' },
        // Higher resolution helps small/far-away barcodes resolve; continuous
        // autofocus (where supported) keeps the barcode sharp without the
        // user having to hold the phone at one exact distance.
        width: { ideal: 1280 },
        height: { ideal: 720 },
        advanced: [{ focusMode: 'continuous' }],
      },
    };

    reader
      .decodeFromConstraints(constraints, videoRef.current ?? undefined, (result, _err, controls) => {
        controlsRef.current = controls;
        if (cancelled || !result) return; // no code in this frame yet — normal, keep scanning
        controls.stop();
        onDetectedRef.current(result.getText());
      })
      .catch((e) => {
        if (cancelled) return;
        const msg = e instanceof Error ? e.message : 'Could not start the camera.';
        setError(/permission|denied/i.test(msg) ? 'Camera permission denied — allow camera access and try again.' : msg);
      });

    return () => {
      // Stops the media stream (turns the camera light off) — without this
      // the browser keeps the camera "on" even after this component unmounts.
      cancelled = true;
      controlsRef.current?.stop();
    };
    // Runs exactly once per mount — onDetected is read via a ref so a new
    // inline function passed in from the caller never restarts the stream.
  }, []);

  return (
    <div
      style={{
        position: 'fixed', inset: 0, zIndex: 100, display: 'flex', flexDirection: 'column', background: '#000',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: 16 }}>
        <span style={{ color: '#fff', fontSize: '0.9rem', fontWeight: 600 }}>Scan barcode</span>
        <button type="button" onClick={onClose} aria-label="Close scanner">
          ✕
        </button>
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
        {error ?? 'Point the camera at the tracking barcode'}
      </div>
    </div>
  );
}
