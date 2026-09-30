const fs = require('fs');
let code = fs.readFileSync('browser-extension/popup.js', 'utf8');

const oldLocalLogic = `const localMyntraEl = document.getElementById('localMyntra');
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
if (localAmazonEl) localAmazonEl.addEventListener('change', handleLocalCheckChange);`;

const newLocalLogic = `const localMyntraEl = document.getElementById('localMyntra');
const localAmazonEl = document.getElementById('localAmazon');
const proxyPeriodAmzEl = document.getElementById('proxyPeriodAmz');
const proxyPeriodMynEl = document.getElementById('proxyPeriodMyn');
const localCheckStatus = document.getElementById('localCheckStatus');

async function loadLocalCheck() {
  const stored = await chrome.storage.local.get(['localMyntra', 'localAmazon', 'proxyPeriodAmazon', 'proxyPeriodMyntra']);
  if (localMyntraEl) localMyntraEl.checked = !!stored.localMyntra;
  if (localAmazonEl) localAmazonEl.checked = !!stored.localAmazon;
  if (proxyPeriodAmzEl) proxyPeriodAmzEl.value = stored.proxyPeriodAmazon || 5;
  if (proxyPeriodMynEl) proxyPeriodMynEl.value = stored.proxyPeriodMyntra || 2;
}
loadLocalCheck();

function handleLocalCheckChange() {
  const pAmz = Math.max(1, parseInt(proxyPeriodAmzEl.value) || 5);
  const pMyn = Math.max(1, parseInt(proxyPeriodMynEl.value) || 2);
  
  chrome.storage.local.set({
    localMyntra: !!localMyntraEl.checked,
    localAmazon: !!localAmazonEl.checked,
    proxyPeriodAmazon: pAmz,
    proxyPeriodMyntra: pMyn
  });
  chrome.runtime.sendMessage({ type: 'update-proxy-alarms' });
  localCheckStatus.style.color = 'var(--good)';
  localCheckStatus.textContent = 'Saved. Check Engine updated.';
  setTimeout(() => { localCheckStatus.textContent = ''; }, 2000);
}

if (localMyntraEl) localMyntraEl.addEventListener('change', handleLocalCheckChange);
if (localAmazonEl) localAmazonEl.addEventListener('change', handleLocalCheckChange);
if (proxyPeriodAmzEl) proxyPeriodAmzEl.addEventListener('input', handleLocalCheckChange);
if (proxyPeriodMynEl) proxyPeriodMynEl.addEventListener('input', handleLocalCheckChange);`;

code = code.replace(oldLocalLogic, newLocalLogic);
fs.writeFileSync('browser-extension/popup.js', code);
