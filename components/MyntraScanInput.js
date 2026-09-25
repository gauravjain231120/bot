'use client';

import { useEffect, useRef, useState } from 'react';
import { BarcodeScanner } from './BarcodeScanner';
import { MyntraTextScanner } from './MyntraTextScanner';
import { unlockScanSound } from './scanSound';

const MODE_KEY_PREFIX = 'myntraScanMode:';

export function MyntraScanInput({ pageKey, busy, onLookup, placeholder }) {
  const [mode, setMode] = useState('barcode');
  const [value, setValue] = useState('');
  const [camera, setCamera] = useState(null); // 'barcode' | 'ocr' | null
  const inputRef = useRef(null);

  useEffect(() => {
    try {
      const saved = window.localStorage.getItem(MODE_KEY_PREFIX + pageKey);
      if (saved === 'barcode' || saved === 'ocr') setMode(saved);
    } catch {
      // storage blocked
    }
  }, [pageKey]);

  useEffect(() => {
    const finePointer = typeof window !== 'undefined' && window.matchMedia && window.matchMedia('(pointer: fine)').matches;
    if (finePointer && !busy && !camera && inputRef.current) inputRef.current.focus();
  }, [busy, camera, mode]);

  function switchMode(next) {
    setMode(next);
    try {
      window.localStorage.setItem(MODE_KEY_PREFIX + pageKey, next);
    } catch {}
  }

  async function submit(override) {
    const v = (override ?? value).trim();
    if (!v || busy) return;
    unlockScanSound();
    setValue(v);
    const ok = await onLookup(v);
    if (ok) setValue('');
  }

  return (
    <>
      <div style={{ display: 'flex', gap: 6, marginBottom: 10 }} role="tablist" aria-label="Camera mode">
        {[['barcode', 'Scan Barcode'], ['ocr', 'Read Text (OCR)']].map(([key, label]) => (
          <button
            key={key}
            type="button"
            role="tab"
            aria-selected={mode === key}
            className={mode === key ? '' : 'secondary'}
            onClick={() => switchMode(key)}
            disabled={busy}
          >
            {label}
          </button>
        ))}
      </div>
      <div style={{ display: 'flex', gap: 8 }}>
        <input
          ref={inputRef}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); submit(); } }}
          placeholder={placeholder || 'MYSR… / MYER… / MYEC…'}
          autoComplete="off"
          style={{ flex: 1, fontFamily: 'monospace', textTransform: 'uppercase' }}
        />
        <button type="button" onClick={() => submit()} disabled={busy || !value.trim()}>
          {busy ? 'Looking up…' : 'Resolve'}
        </button>
      </div>
      <button
        type="button"
        className="secondary"
        onClick={() => { unlockScanSound(); setCamera(mode); }}
        disabled={busy}
        style={{ width: '100%', justifyContent: 'center', marginTop: 8 }}
      >
        {mode === 'ocr' ? '📷 Read tracking ID text with camera' : '📷 Scan barcode with camera'}
      </button>

      {camera === 'barcode' && (
        <BarcodeScanner onDetected={(text) => { setCamera(null); submit(text); }} onClose={() => setCamera(null)} />
      )}
      {camera === 'ocr' && (
        <MyntraTextScanner onDetected={(text) => { setCamera(null); submit(text); }} onClose={() => setCamera(null)} />
      )}
    </>
  );
}
