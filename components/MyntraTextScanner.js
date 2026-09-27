'use client';

import { TextIdScanner } from './TextIdScanner';
import { readMyntraId } from './scanImage';

// Myntra tracking ids (MYSR… / MYSP… / MYEC… …) read from the printed text.
// The label prints the same id as a barcode right under the text, and the
// scanner reads that too: a barcode read is exact, so when it comes it wins
// over the OCR (OCR can take a faint 0 for an 8). See TextIdScanner.
const MYNTRA_BARCODE = /^MY[A-Z]{2}\d{8,}$/;

function myntraIdFromBarcode(text) {
  const t = String(text || '').trim().toUpperCase();
  return MYNTRA_BARCODE.test(t) ? t : null;
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
