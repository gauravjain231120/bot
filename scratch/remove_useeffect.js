const fs = require('fs');
for (const file of ['/Users/gauravbhandari/Desktop/myntra-order-alert-web/app/returns/page.js', '/Users/gauravbhandari/Desktop/myntra-order-alert-web/app/packed/page.js']) {
  let code = fs.readFileSync(file, 'utf8');
  code = code.replace(/useEffect\(\(\) => \{\n\s*const finePointer = typeof window.*?matches;\n\s*if \(finePointer.*?\)\;\n\s*\}, \[.*?\]\);\n/, '');
  // remove handleBarcodeDetected if any
  code = code.replace(/function handleBarcodeDetected\(text\) \{\n.*?setCameraOpen\(false\);\n.*?\n.*?\n\s*\}/s, '');
  fs.writeFileSync(file, code);
}
