'use client';

import { useState } from 'react';

// Scan feedback beeps shared by all four scan pages (Myntra Pack / Myntra
// Return / Amazon Pack / Amazon Return). The tones are generated with the Web
// Audio API — no sound files, nothing to download, works offline — the same
// "everything is made in code" approach as the rest of the scanner.
//
// Two distinct sounds so the packer can tell the result without looking at the
// screen: a single bright note for a good scan, two low buzzes for "not found /
// couldn't read it".
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

// One short enveloped note. A tiny attack/release ramp keeps it from clicking.
function tone({ freq, delay = 0, duration, type = 'sine', gain = 0.18 }) {
  const c = audioContext();
  if (!c) return;
  if (c.state === 'suspended') c.resume().catch(() => {});
  const t0 = c.currentTime + delay;
  const osc = c.createOscillator();
  const amp = c.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t0);
  amp.gain.setValueAtTime(0, t0);
  amp.gain.linearRampToValueAtTime(gain, t0 + 0.012);
  amp.gain.exponentialRampToValueAtTime(0.0001, t0 + duration);
  osc.connect(amp);
  amp.connect(c.destination);
  osc.start(t0);
  osc.stop(t0 + duration + 0.02);
}

/** Good scan — one bright rising note. Silent when scan sound is off. */
export function playScanSuccess() {
  if (!readSoundPref()) return;
  tone({ freq: 660, duration: 0.09 });
  tone({ freq: 990, delay: 0.08, duration: 0.11 });
}

/** Not found / bad scan — two low buzzes. Silent when scan sound is off. */
export function playScanError() {
  if (!readSoundPref()) return;
  tone({ freq: 200, duration: 0.13, type: 'square', gain: 0.14 });
  tone({ freq: 150, delay: 0.17, duration: 0.17, type: 'square', gain: 0.14 });
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
      title="Scan sound — On beeps for a good scan and buzzes for a not-found scan. Saved on this phone."
    >
      {on ? '🔊 On' : '🔇 Off'}
    </button>
  );
}
