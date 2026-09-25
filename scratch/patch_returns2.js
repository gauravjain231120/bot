const fs = require('fs');
const file = '/Users/gauravbhandari/Desktop/myntra-order-alert-web/app/returns/page.js';
let code = fs.readFileSync(file, 'utf8');

const barcodeRendering = `{cameraOpen && <BarcodeScanner onDetected={handleBarcodeDetected} onClose={() => setCameraOpen(false)} />}`;

if (code.includes(barcodeRendering)) {
  code = code.replace(barcodeRendering, '');
  fs.writeFileSync(file, code);
  console.log("Patched rendering logic");
} else {
  console.log("Still not found");
}
