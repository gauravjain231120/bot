const fs = require('fs');
let html = fs.readFileSync('browser-extension/popup.html', 'utf8');

const localCheckCard = `
    <div class="card">
      <div class="settings-title">Local Checking (Anti-Block)</div>
      <div class="hint">Check orders straight from this browser to avoid cloud WAF blocks.</div>
      <div class="period-row">
        <label for="localMyntra">Myntra</label>
        <input type="checkbox" id="localMyntra" style="width: auto;" />
      </div>
      <div class="period-row">
        <label for="localAmazon">Amazon</label>
        <input type="checkbox" id="localAmazon" style="width: auto;" />
      </div>
      <div class="save-status" id="localCheckStatus"></div>
    </div>
`;

html = html.replace(
  '<button class="btn-primary" id="sync">Sync now</button>',
  localCheckCard + '\n    <button class="btn-primary" id="sync">Sync now</button>'
);

fs.writeFileSync('browser-extension/popup.html', html);
