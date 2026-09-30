const fs = require('fs');
let code = fs.readFileSync('browser-extension/popup.js', 'utf8');

const target = `function handleLocalCheckChange() {
  const pAmz = Math.max(1, parseInt(proxyPeriodAmzEl.value) || 5);
  const pMyn = Math.max(1, parseInt(proxyPeriodMynEl.value) || 2);
  
  const isAmz = !!localAmazonEl.checked;
  const isMyn = !!localMyntraEl.checked;

  chrome.storage.local.set({
    localMyntra: isMyn,
    localAmazon: isAmz,
    proxyPeriodAmazon: pAmz,
    proxyPeriodMyntra: pMyn
  }, () => {
    chrome.runtime.sendMessage({ type: 'update-proxy-alarms' });
    
    // Instant Mode Switch Triggers (Only if toggle was clicked, skip if just interval changed)
    if (this && this.id === 'localAmazon') {
      chrome.runtime.sendMessage({ type: 'manual-mode-switch', marketplace: 'amazon', mode: isAmz ? 'local' : 'cloud' });
    } else if (this && this.id === 'localMyntra') {
      chrome.runtime.sendMessage({ type: 'manual-mode-switch', marketplace: 'myntra', mode: isMyn ? 'local' : 'cloud' });
    }
  });`;

const rep = `function handleLocalCheckChange(e) {
  const pAmz = Math.max(1, parseInt(proxyPeriodAmzEl.value) || 5);
  const pMyn = Math.max(1, parseInt(proxyPeriodMynEl.value) || 2);
  
  const isAmz = !!localAmazonEl.checked;
  const isMyn = !!localMyntraEl.checked;

  chrome.storage.local.set({
    localMyntra: isMyn,
    localAmazon: isAmz,
    proxyPeriodAmazon: pAmz,
    proxyPeriodMyntra: pMyn
  }, () => {
    chrome.runtime.sendMessage({ type: 'update-proxy-alarms' });
    
    // Instant Mode Switch Triggers (Only if toggle was clicked, skip if just interval changed)
    if (e && e.target && e.target.id === 'localAmazon') {
      chrome.runtime.sendMessage({ type: 'manual-mode-switch', marketplace: 'amazon', mode: isAmz ? 'local' : 'cloud' });
    } else if (e && e.target && e.target.id === 'localMyntra') {
      chrome.runtime.sendMessage({ type: 'manual-mode-switch', marketplace: 'myntra', mode: isMyn ? 'local' : 'cloud' });
    }
  });`;

code = code.replace(target, rep);
fs.writeFileSync('browser-extension/popup.js', code);
