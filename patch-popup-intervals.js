const fs = require('fs');
let html = fs.readFileSync('browser-extension/popup.html', 'utf8');

const oldAmzHeader = '<div class="engine-header">\n          <span class="engine-name">Amazon</span>\n          <label class="switch">';

const newAmzHeader = '<div class="engine-header">\n          <span class="engine-name">Amazon</span>\n          <div style="display:flex; align-items:center; gap:8px;">\n            <div style="font-size:11px; color:var(--muted); display:flex; align-items:center; gap:3px;">\n              Every <input type="number" id="proxyPeriodAmz" style="width:36px; padding:2px; border:1px solid var(--border); border-radius:4px; text-align:center; font-size:11px;" min="1" max="60" value="5"> min\n            </div>\n            <label class="switch">';

html = html.replace(oldAmzHeader, newAmzHeader);

const oldMynHeader = '<div class="engine-header">\n          <span class="engine-name">Myntra</span>\n          <label class="switch">';

const newMynHeader = '<div class="engine-header">\n          <span class="engine-name">Myntra</span>\n          <div style="display:flex; align-items:center; gap:8px;">\n            <div style="font-size:11px; color:var(--muted); display:flex; align-items:center; gap:3px;">\n              Every <input type="number" id="proxyPeriodMyn" style="width:36px; padding:2px; border:1px solid var(--border); border-radius:4px; text-align:center; font-size:11px;" min="1" max="60" value="2"> min\n            </div>\n            <label class="switch">';

html = html.replace(oldMynHeader, newMynHeader);

// Close the extra div we opened before the switch label
html = html.replace(/<\/label>\s*<\/div>\s*<div class="engine-actions">/g, '</label>\n          </div>\n        </div>\n        <div class="engine-actions">');

fs.writeFileSync('browser-extension/popup.html', html);
