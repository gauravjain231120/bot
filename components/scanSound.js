'use client';

import { useState } from 'react';

// Scan feedback beeps shared by all four scan pages (Myntra Pack / Myntra
// Return / Amazon Pack / Amazon Return). The tones are generated with the Web
// Audio API — no sound files, nothing to download, works offline — the same
// "everything is made in code" approach as the rest of the scanner.
//
// Two distinct sounds so the packer can tell the result without looking at the
// screen:
//   - good scan: a bright two-note rising chime (E6 → B6, a perfect fifth)
//     with a soft bell tone — the "done!" feel of a payment chime. High-pitched
//     so it carries over a noisy room; ~0.4 s, so rapid scanning isn't slowed.
//   - not found / couldn't read: a soft descending "uh-oh" (A4 → F#4, a minor
//     third) in a rounded, filtered tone — unmistakably "no", never a harsh
//     buzz you'd hate hearing all day.
// Both run through one gentle compressor, so they're loud but never distort.
//
// On/off is a saved preference (localStorage, per device) exactly like the
// flashlight choice in useTorch.js — it survives a reload and applies to every
// scanner from then on. Default on.
//
// Mobile browsers (iPhone Chrome/Safari and Android Chrome) refuse to play any
// audio until the page has seen a real user gesture, and an AudioContext
// created before that starts "suspended". So unlockScanSound() is called from
// the tap that opens the camera or runs a lookup — a genuine gesture — which
// creates and resumes the shared context once. The beeps then fire later from
// the async scan result, which is allowed because the context is already
// running. Every play still tries to resume defensively, so a context the OS
// suspended in the background wakes back up.
//
// iPhone note: this is sound only. Apple does not let a web page vibrate the
// phone (there is no navigator.vibrate on iOS), so there is deliberately no
// haptic part here.

const SOUND_ON_KEY = 'scanSoundOn';

let ctx = null;

function readSoundPref() {
  try {
    return window.localStorage.getItem(SOUND_ON_KEY) !== 'off';
  } catch {
    return true; // storage blocked — default on
  }
}

function saveSoundPref(on) {
  try {
    window.localStorage.setItem(SOUND_ON_KEY, on ? 'on' : 'off');
  } catch {
    // storage blocked — the choice just isn't remembered next time
  }
}

/** Whether scan beeps are currently enabled (saved per device, default on). */
export function isScanSoundOn() {
  return readSoundPref();
}

/** Turn scan beeps on/off and remember it on this device. */
export function setScanSound(on) {
  saveSoundPref(on);
}

function audioContext() {
  if (typeof window === 'undefined') return null;
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return null; // very old browser — no sound, scanning still works
  if (!ctx) ctx = new AC();
  return ctx;
}

/**
 * Create/resume the shared AudioContext. Call from a user-gesture handler
 * (the tap that opens the camera or runs a lookup) so later beeps are allowed
 * to play. Safe to call as often as you like — it does nothing once running.
 */
export function unlockScanSound() {
  const c = audioContext();
  if (c && c.state === 'suspended') c.resume().catch(() => {});
}

// Shared output for all scan sounds: a compressor (evens out loudness, stops
// overlapping notes from clipping) plus a little make-up gain. One per
// AudioContext.
function outputBus(c) {
  if (c.__scanBus) return c.__scanBus;
  const comp = c.createDynamicsCompressor();
  // Tuned so both sounds peak around -2 dBFS: loud enough for a busy room
  // (like the old square-wave beep), no distortion even when notes overlap.
  comp.threshold.value = -12;
  comp.knee.value = 6;
  comp.ratio.value = 4;
  comp.attack.value = 0.002;
  comp.release.value = 0.12;
  const makeup = c.createGain();
  makeup.gain.value = 2.2;
  comp.connect(makeup);
  makeup.connect(c.destination);
  c.__scanBus = comp;
  return comp;
}

/**
 * One note: a few oscillators at multiples of `freq` (partials: [multiple,
 * level]) under a single fast-attack / smooth-decay envelope, so it rings like
 * a small bell rather than beeping. `glide` starts the pitch that fraction
 * higher and settles it (a soft "droop"); `lowpass` rounds the tone off.
 * Scheduled a hair ahead so quick successive notes never drop or click.
 */
function note({ freq, at = 0, dur, gain = 0.3, partials = [[1, 1]], type = 'sine', glide = 0, lowpass = 0 }) {
  const c = audioContext();
  if (!c) return;
  if (c.state === 'suspended') c.resume().catch(() => {});
  const t0 = c.currentTime + 0.01 + at;
  const env = c.createGain();
  env.gain.setValueAtTime(0.0001, t0);
  env.gain.exponentialRampToValueAtTime(gain, t0 + 0.006);
  env.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  let dest = outputBus(c);
  if (lowpass) {
    const filter = c.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = lowpass;
    filter.Q.value = 0.7;
    filter.connect(dest);
    dest = filter;
  }
  env.connect(dest);
  for (const [mult, level] of partials) {
    const osc = c.createOscillator();
    const lvl = c.createGain();
    osc.type = type;
    const f = freq * mult;
    if (glide) {
      osc.frequency.setValueAtTime(f * (1 + glide), t0);
      osc.frequency.exponentialRampToValueAtTime(f, t0 + Math.min(0.08, dur / 2));
    } else {
      osc.frequency.setValueAtTime(f, t0);
    }
    lvl.gain.value = level;
    osc.connect(lvl);
    lvl.connect(env);
    osc.start(t0);
    osc.stop(t0 + dur + 0.05);
  }
}

// Bell-like: the note plus quieter 2nd/3rd harmonics, very slightly detuned
// so it shimmers.
const BELL = [[1, 1], [2.003, 0.22], [3.006, 0.06]];

/** Good scan — bright rising two-note chime. Silent when scan sound is off. */
export function playScanSuccess() {
  if (!readSoundPref()) return;
  note({ freq: 1318.51, at: 0, dur: 0.2, gain: 0.32, partials: BELL }); // E6
  note({ freq: 1975.53, at: 0.075, dur: 0.42, gain: 0.36, partials: BELL }); // B6
  note({ freq: 3951.07, at: 0.075, dur: 0.18, gain: 0.04 }); // B7 sparkle on top
}

/** Not found / bad scan — soft descending "uh-oh". Silent when scan sound is off. */
export function playScanError() {
  if (!readSoundPref()) return;
  const tone = [[1, 1], [2, 0.18], [3, 0.08]]; // the 3rd harmonic helps it cut through noise
  note({ freq: 440, at: 0, dur: 0.16, gain: 0.5, type: 'triangle', partials: tone, glide: 0.03, lowpass: 2400 }); // A4
  note({ freq: 369.99, at: 0.16, dur: 0.34, gain: 0.55, type: 'triangle', partials: tone, glide: 0.04, lowpass: 2000 }); // F#4
}

/**
 * 🔊 On / 🔇 Off button for the scanner header — the sound counterpart to the
 * flashlight buttons. Saved on this device, so it's remembered across reloads
 * and every scanner. Always rendered (unlike the torch buttons, which hide on
 * browsers that can't control the flash — e.g. iPhone). Turning it on plays
 * one success chirp so you can hear it's working.
 */
export function SoundButton() {
  // Scanners only mount after a tap (never server-rendered), so reading the
  // saved preference in the initial state is safe — same as useTorch.
  const [on, setOn] = useState(readSoundPref);

  function toggle() {
    const next = !on;
    saveSoundPref(next);
    setOn(next);
    if (next) {
      // This click is a user gesture, so unlocking + chirping here is allowed.
      unlockScanSound();
      playScanSuccess();
    }
  }

  return (
    <button
      type="button"
      onClick={toggle}
      aria-pressed={on}
      aria-label={on ? 'Turn scan sound off' : 'Turn scan sound on'}
      title="Scan sound — On chimes for a good scan and plays a soft “uh-oh” for a not-found scan. Saved on this phone."
    >
      {on ? '🔊 On' : '🔇 Off'}
    </button>
  );
}
