'use client';

import { TextIdScanner } from './TextIdScanner';
import { readMyntraId, isMyntraBarcode } from './scanImage';

// Myntra tracking ids (MYSR… / MYSP… / MYEC… …) read from the printed text.
// The label prints the same id as a barcode right under the text, and the
// scanner reads that too: a barcode read is exact, so when it comes it wins
// over the OCR (OCR can take a faint 0 for an 8). See TextIdScanner.
function myntraIdFromBarcode(text) {
  const t = String(text || '').trim().toUpperCase();
  return isMyntraBarcode(t) ? t : null;
}

/** Full-screen camera reader for a Myntra tracking id. Calls onDetected('MYSR1234567890'). */
export function MyntraTextScanner({ onDetected, onClose }) {
  return (
    <TextIdScanner
      title="Read tracking ID"
      hint="Hold the tracking ID (and its barcode) inside the box — any way up"
      whitelist="0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ"
      readId={readMyntraId}
      fromBarcode={myntraIdFromBarcode}
      onDetected={onDetected}
      onClose={onClose}
    />
  );
}
