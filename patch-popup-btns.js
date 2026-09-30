const fs = require('fs');
let code = fs.readFileSync('browser-extension/popup.js', 'utf8');

const btnLogic = `
function wireTestButton(btnId, type, marketplace, resId) {
  const btn = document.getElementById(btnId);
  const resEl = document.getElementById(resId);
  if (!btn || !resEl) return;
  
  btn.addEventListener('click', () => {
    btn.disabled = true;
    resEl.style.color = 'var(--muted)';
    resEl.textContent = 'Testing...';
    
    chrome.runtime.sendMessage({ type, marketplace }, (res) => {
      btn.disabled = false;
      if (!res) {
        resEl.style.color = 'var(--bad)';
        resEl.textContent = 'Extension error';
        return;
      }
      
      if (res.ok) {
        resEl.style.color = 'var(--good)';
        resEl.textContent = \`✅ Success: \${res.count} orders (\${type === 'test-local' ? 'Local' : 'Cloud'})\`;
      } else {
        resEl.style.color = 'var(--bad)';
        resEl.textContent = \`❌ Failed: \${res.message || res.error || 'Unknown error'}\`;
      }
    });
  });
}

wireTestButton('testAmzLocal', 'test-local', 'amazon', 'resAmz');
wireTestButton('testAmzCloud', 'test-cloud', 'amazon', 'resAmz');
wireTestButton('testMynLocal', 'test-local', 'myntra', 'resMyn');
wireTestButton('testMynCloud', 'test-cloud', 'myntra', 'resMyn');
`;

// Replace the old simple local logic with the new one
code = code.replace(/const localMyntraEl = document\.getElementById\('localMyntra'\);[\s\S]*?localAmazonEl\.addEventListener\('change', handleLocalCheckChange\);/, '');

const localLogic = `
const localMyntraEl = document.getElementById('localMyntra');
const localAmazonEl = document.getElementById('localAmazon');
const localCheckStatus = document.getElementById('localCheckStatus');

async function loadLocalCheck() {
  const stored = await chrome.storage.local.get(['localMyntra', 'localAmazon']);
  if (localMyntraEl) localMyntraEl.checked = !!stored.localMyntra;
  if (localAmazonEl) localAmazonEl.checked = !!stored.localAmazon;
}
loadLocalCheck();

function handleLocalCheckChange() {
  chrome.storage.local.set({
    localMyntra: !!localMyntraEl.checked,
    localAmazon: !!localAmazonEl.checked
  });
  localCheckStatus.style.color = 'var(--good)';
  localCheckStatus.textContent = 'Saved. Check Engine updated.';
  setTimeout(() => { localCheckStatus.textContent = ''; }, 2000);
}

if (localMyntraEl) localMyntraEl.addEventListener('change', handleLocalCheckChange);
if (localAmazonEl) localAmazonEl.addEventListener('change', handleLocalCheckChange);
` + btnLogic;

code = code + '\n' + localLogic;
fs.writeFileSync('browser-extension/popup.js', code);
