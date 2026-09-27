'use client';

import { TextIdScanner } from './TextIdScanner';
import { readOrderId } from './scanImage';

// Amazon order ids are printed on labels/invoices as text (3-7-7 digits), so
// this reads them with OCR — see TextIdScanner for how, and for the rule that
// never accepts an uncertain read. If a barcode in view encodes an order id,
// that exact read is used instead.
const ORDER_ID_BARCODE = /^(\d{3})-?(\d{7})-?(\d{7})$/;

function orderIdFromBarcode(text) {
  const m = String(text || '').trim().match(ORDER_ID_BARCODE);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
}

/** Full-screen camera reader for a printed Amazon order id. Calls onDetected('###-#######-#######'). */
export function OrderIdScanner({ onDetected, onClose }) {
  return (
    <TextIdScanner
      title="Read order ID"
      hint="Hold the order ID inside the box — any way up, faint print is fine"
      whitelist="0123456789-"
      readId={readOrderId}
      fromBarcode={orderIdFromBarcode}
      onDetected={onDetected}
      onClose={onClose}
    />
  );
}
