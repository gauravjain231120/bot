const fs = require('fs');
const file = '/Users/gauravbhandari/Desktop/myntra-order-alert-web/app/returns/page.js';
let code = fs.readFileSync(file, 'utf8');

const uiToReplace = `        <div style={{ display: 'flex', gap: 8 }}>
          <input
            ref={inputRef}
            autoComplete="off"
            value={myntraScanId}
            onChange={(e) => setMyntraScanId(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); resolveMyntraReturn(); } }}
            placeholder="MYSR… / MYER… / MYEC…"
            style={{ flex: 1, fontFamily: 'monospace' }}
          />
          <button type="button" onClick={() => resolveMyntraReturn()} disabled={myntraResolving || !myntraScanId.trim()}>
            {myntraResolving ? 'Looking up…' : 'Resolve'}
          </button>
        </div>

        <button
          type="button"
          className="secondary"
          onClick={() => { unlockScanSound(); setCameraOpen(true); }}
          disabled={myntraResolving}
          style={{ width: '100%', justifyContent: 'center', marginTop: 8 }}
        >
          📷 Scan with camera
        </button>`;

const replacement = `        <MyntraScanInput
          pageKey="returns"
          busy={myntraResolving}
          onLookup={resolveMyntraReturn}
        />`;

if (code.includes(uiToReplace)) {
  code = code.replace(uiToReplace, replacement);
} else {
  console.log("Could not find exact UI match in returns/page.js");
}

// Also remove BarcodeScanner rendering block
const barcodeRendering = `{cameraOpen && (
        <BarcodeScanner
          onDetected={(text) => { setCameraOpen(false); resolveMyntraReturn(text); }}
          onClose={() => setCameraOpen(false)}
        />
      )}`;

if (code.includes(barcodeRendering)) {
  code = code.replace(barcodeRendering, '');
} else {
  console.log("Could not find BarcodeScanner rendering block in returns/page.js");
}

fs.writeFileSync(file, code);
