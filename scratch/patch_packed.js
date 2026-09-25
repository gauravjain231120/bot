const fs = require('fs');
const file = '/Users/gauravbhandari/Desktop/myntra-order-alert-web/app/packed/page.js';
let code = fs.readFileSync(file, 'utf8');

const uiToReplace = `        <div style={{ display: 'flex', gap: 8 }}>
          <input
            ref={inputRef}
            value={scanId}
            onChange={(e) => setScanId(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); lookup(); } }}
            placeholder="MYSP… / MYSC… / packet ID"
            style={{ flex: 1, fontFamily: 'monospace' }}
            autoComplete="off"
          />
          <button type="button" onClick={() => lookup()} disabled={looking || !scanId.trim()}>
            {looking ? 'Looking up…' : 'Look up'}
          </button>
        </div>

        <button
          type="button"
          className="secondary"
          onClick={() => { unlockScanSound(); setCameraOpen(true); }}
          disabled={looking}
          style={{ width: '100%', justifyContent: 'center', marginTop: 8 }}
        >
          📷 Scan with camera
        </button>`;

const replacement = `        <MyntraScanInput
          pageKey="packed"
          busy={looking}
          onLookup={lookup}
          placeholder="MYSP… / MYSC… / packet ID"
        />`;

if (code.includes(uiToReplace)) {
  code = code.replace(uiToReplace, replacement);
  console.log("Patched packed UI");
} else {
  console.log("Could not find exact UI match in packed/page.js");
}

const barcodeRendering = `{cameraOpen && (
        <BarcodeScanner
          onDetected={(text) => { setCameraOpen(false); lookup(text); }}
          onClose={() => setCameraOpen(false)}
        />
      )}`;
if (code.includes(barcodeRendering)) {
  code = code.replace(barcodeRendering, '');
  console.log("Patched rendering logic in packed");
} else {
  console.log("Barcode rendering not found in packed");
}

fs.writeFileSync(file, code);
