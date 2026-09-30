const fs = require('fs');
let code = fs.readFileSync('browser-extension/manifest.json', 'utf8');
code = code.replace('"permissions": ["cookies", "storage", "alarms"]', '"permissions": ["cookies", "storage", "alarms", "power"]');
fs.writeFileSync('browser-extension/manifest.json', code);
