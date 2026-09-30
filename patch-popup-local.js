const fs = require('fs');
let code = fs.readFileSync('browser-extension/popup.js', 'utf8');

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
  localCheckStatus.textContent = 'Saved. Proxy active.';
  setTimeout(() => { localCheckStatus.textContent = ''; }, 2000);
}

if (localMyntraEl) localMyntraEl.addEventListener('change', handleLocalCheckChange);
if (localAmazonEl) localAmazonEl.addEventListener('change', handleLocalCheckChange);
`;

code = code + '\n' + localLogic;
fs.writeFileSync('browser-extension/popup.js', code);
