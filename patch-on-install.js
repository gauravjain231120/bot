const fs = require('fs');
let code = fs.readFileSync('browser-extension/background.js', 'utf8');

code = code.replace(
  'chrome.runtime.onInstalled.addListener((details) => {\n  ensureAlarms().then(updateBadge);',
  'chrome.runtime.onInstalled.addListener((details) => {\n  ensureAlarms().then(updateBadge);\n  ensureProxyAlarms();'
);

fs.writeFileSync('browser-extension/background.js', code);
