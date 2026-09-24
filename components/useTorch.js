'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

// Flashlight control shared by both camera scanners (BarcodeScanner for
// Myntra/Amazon tracking barcodes, OrderIdScanner for printed Amazon order
// ids) — manual on/off plus "auto flash": the flash switches itself on when
// the camera picture stays dark.
//
// How "dark" is measured: twice a second a tiny (48x27) copy of the live frame
// is averaged to one brightness number (0-255, Rec.709 luma). The phone's own
// auto-exposure brightens dim scenes, so a real low-light frame still reads
// fairly dark but noisy — below DARK_LUMA for DARK_SAMPLES samples in a row
// (~1.5 s) counts as low light. The first WARMUP_MS are skipped while
// auto-exposure settles (the first frames are often black).
//
// Once auto has switched the flash on it stays on until the scanner closes:
// the flash lights the picture itself, so brightness can no longer tell
// whether the room got lighter — turning it off again would just flicker.
// A tap on 🔦 always wins for the rest of that scan (auto stops deciding).
//
// The Auto on/off choice is saved on this device (localStorage) and used by
// every scanner from then on. Default: on.
//
// Browsers: Android Chrome supports the torch constraint on most phones;
// iPhone Safari doesn't let web pages control the flash at all — there the
// flash buttons are hidden and a low-light hint is shown instead.

const PREF_KEY = 'scanAutoFlash';
const SAMPLE_MS = 500;
const WARMUP_MS = 1200;
const DARK_LUMA = 75;
const DARK_SAMPLES = 3;

/**
 * Pure decision for one brightness sample (kept separate so it can be tested
 * without a camera). Returns the new dark-streak count, whether it's low
 * light now, and whether to switch the flash on.
 */
export function lightStep({ darkCount, luma, auto, supported, manual, autoTried }) {
  const count = luma < DARK_LUMA ? darkCount + 1 : 0;
  const isDark = count >= DARK_SAMPLES;
  return { darkCount: count, isDark, turnOn: isDark && auto && supported && !manual && !autoTried };
}

function readAutoPref() {
  try {
    return window.localStorage.getItem(PREF_KEY) !== 'off';
  } catch {
    return true; // storage blocked — default on
  }
}

function saveAutoPref(on) {
  try {
    window.localStorage.setItem(PREF_KEY, on ? 'on' : 'off');
  } catch {
    // storage blocked — the choice just isn't remembered next time
  }
}

/**
 * @param {React.RefObject<HTMLVideoElement>} videoRef  the scanner's live video
 * @returns {{ attach(track), supported, on, toggle(), auto, setAuto(bool), dark }}
 *   Call attach(track) once the camera stream is playing.
 */
export function useTorch(videoRef) {
  const trackRef = useRef(null);
  const attachedAtRef = useRef(0);
  const onRef = useRef(false);
  const manualRef = useRef(false); // user tapped 🔦 — auto stops deciding
  const autoTriedRef = useRef(false); // auto already switched it on (or tried) this scan
  const darkRef = useRef(false);
  const [supported, setSupported] = useState(false);
  const [on, setOn] = useState(false);
  // Scanners only mount after a tap (never server-rendered), so reading
  // storage in the initial state is safe.
  const [auto, setAutoState] = useState(readAutoPref);
  const autoRef = useRef(auto);
  const supportedRef = useRef(false);
  const [dark, setDark] = useState(false);

  const apply = useCallback(async (next) => {
    const track = trackRef.current;
    if (!track || track.readyState !== 'live') return false;
    try {
      await track.applyConstraints({ advanced: [{ torch: next }] });
      onRef.current = next;
      setOn(next);
      return true;
    } catch {
      // Some browsers list torch as a capability but reject it at runtime.
      return false;
    }
  }, []);

  const attach = useCallback((track) => {
    trackRef.current = track;
    attachedAtRef.current = Date.now();
    const caps = track && track.getCapabilities ? track.getCapabilities() : {};
    supportedRef.current = !!caps.torch;
    setSupported(!!caps.torch);
  }, []);

  useEffect(() => {
    const canvas = document.createElement('canvas');
    canvas.width = 48;
    canvas.height = 27;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    let darkCount = 0;

    const id = setInterval(() => {
      const video = videoRef.current;
      const track = trackRef.current;
      if (!ctx || !video || !track || track.readyState !== 'live' || !video.videoWidth) return;
      if (Date.now() - attachedAtRef.current < WARMUP_MS) return;
      if (onRef.current) {
        // Lit by the flash — the reading says nothing about the room.
        if (darkRef.current) {
          darkRef.current = false;
          setDark(false);
        }
        return;
      }
      let luma = 255;
      try {
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        const px = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
        let sum = 0;
        for (let i = 0; i < px.length; i += 4) sum += 0.2126 * px[i] + 0.7152 * px[i + 1] + 0.0722 * px[i + 2];
        luma = sum / (px.length / 4);
      } catch {
        return; // frame not ready — try next tick
      }
      const step = lightStep({
        darkCount,
        luma,
        auto: autoRef.current,
        supported: supportedRef.current,
        manual: manualRef.current,
        autoTried: autoTriedRef.current,
      });
      darkCount = step.darkCount;
      if (step.isDark !== darkRef.current) {
        darkRef.current = step.isDark;
        setDark(step.isDark);
      }
      if (step.turnOn) {
        autoTriedRef.current = true;
        apply(true);
      }
    }, SAMPLE_MS);
    return () => clearInterval(id);
  }, [videoRef, apply]);

  const toggle = useCallback(() => {
    manualRef.current = true;
    apply(!onRef.current);
  }, [apply]);

  const setAuto = useCallback(
    (next) => {
      autoRef.current = next;
      setAutoState(next);
      saveAutoPref(next);
      if (next) {
        // Re-armed: if it's dark right now the next sample switches it on.
        autoTriedRef.current = false;
        manualRef.current = false;
      } else if (onRef.current && !manualRef.current) {
        // Auto had switched it on — turning auto off turns it back off.
        apply(false);
      }
    },
    [apply]
  );

  return { attach, supported, on, toggle, auto, setAuto, dark };
}

/** Header buttons: Auto flash on/off + manual 🔦 (only where the flash can be controlled). */
export function TorchButtons({ torch }) {
  if (!torch.supported) return null;
  return (
    <>
      <button
        type="button"
        onClick={() => torch.setAuto(!torch.auto)}
        aria-pressed={torch.auto}
        title="Auto flash: switches the flashlight on by itself when it's too dark to scan. Saved on this phone."
      >
        {torch.auto ? '⚡ Auto on' : '⚡ Auto off'}
      </button>
      <button
        type="button"
        onClick={torch.toggle}
        aria-pressed={torch.on}
        aria-label={torch.on ? 'Turn off flashlight' : 'Turn on flashlight — helps with a faint print or low light'}
        title="Flashlight"
      >
        {torch.on ? '🔦 On' : '🔦 Off'}
      </button>
    </>
  );
}

/** One line for the scanner's footer when it's dark and the flash isn't helping yet, else null. */
export function lowLightHint(torch) {
  if (!torch.dark || torch.on) return null;
  if (!torch.supported) return 'Low light — move to a brighter spot (this browser can’t switch the flash on).';
  if (!torch.auto) return 'Low light — tap 🔦 to turn the flash on, or switch ⚡ Auto on.';
  return 'Low light — tap 🔦 if the flash didn’t come on.';
}
