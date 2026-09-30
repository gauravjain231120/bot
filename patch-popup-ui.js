const fs = require('fs');
let html = fs.readFileSync('browser-extension/popup.html', 'utf8');

// The new super cool local checking card
const coolLocalCheckCard = `
    <div class="card">
      <div class="settings-title">Scraping Engine</div>
      <div class="hint">Turn ON Local Checking to scrape directly from this browser, making it 100% immune to cloud WAF blocks.</div>
      
      <!-- Amazon Row -->
      <div class="engine-row">
        <div class="engine-header">
          <span class="engine-name">Amazon</span>
          <label class="switch">
            <input type="checkbox" id="localAmazon">
            <span class="slider round"></span>
          </label>
        </div>
        <div class="engine-actions">
          <button class="btn-test" id="testAmzLocal">Test Local</button>
          <button class="btn-test" id="testAmzCloud">Test Cloud</button>
        </div>
        <div class="test-result" id="resAmz"></div>
      </div>

      <!-- Myntra Row -->
      <div class="engine-row" style="margin-top: 12px; padding-top: 12px; border-top: 1px solid var(--border);">
        <div class="engine-header">
          <span class="engine-name">Myntra</span>
          <label class="switch">
            <input type="checkbox" id="localMyntra">
            <span class="slider round"></span>
          </label>
        </div>
        <div class="engine-actions">
          <button class="btn-test" id="testMynLocal">Test Local</button>
          <button class="btn-test" id="testMynCloud">Test Cloud</button>
        </div>
        <div class="test-result" id="resMyn"></div>
      </div>

      <div class="save-status" id="localCheckStatus"></div>
    </div>
`;

// Inject the CSS for the super cool toggles and buttons
const customCss = `
      .engine-row { display: flex; flex-direction: column; gap: 8px; }
      .engine-header { display: flex; align-items: center; justify-content: space-between; }
      .engine-name { font-weight: 600; font-size: 13px; }
      .engine-actions { display: flex; gap: 6px; }
      .btn-test { flex: 1; padding: 6px; font-size: 11px; font-weight: 600; border-radius: 6px; border: 1px solid var(--border); background: var(--bg); cursor: pointer; color: var(--text); }
      .btn-test:hover { background: #e5e7eb; }
      .btn-test:active { opacity: 0.7; }
      .test-result { font-size: 11px; min-height: 14px; font-weight: 500; }
      
      /* The switch - the box around the slider */
      .switch { position: relative; display: inline-block; width: 34px; height: 20px; }
      .switch input { opacity: 0; width: 0; height: 0; }
      .slider { position: absolute; cursor: pointer; top: 0; left: 0; right: 0; bottom: 0; background-color: #ccc; transition: .2s; }
      .slider:before { position: absolute; content: ""; height: 14px; width: 14px; left: 3px; bottom: 3px; background-color: white; transition: .2s; }
      input:checked + .slider { background-color: var(--brand); }
      input:checked + .slider:before { transform: translateX(14px); }
      .slider.round { border-radius: 20px; }
      .slider.round:before { border-radius: 50%; }
`;

html = html.replace('</style>', customCss + '\n    </style>');

// Remove the old simple card and replace with the new cool one
html = html.replace(/<div class="card">\s*<div class="settings-title">Local Checking.*?<\/div>\s*<\/div>/s, coolLocalCheckCard);

fs.writeFileSync('browser-extension/popup.html', html);
