const fs = require('fs');
let code = fs.readFileSync('browser-extension/popup.js', 'utf8');

const target = `  chrome.storage.local.set({
    localMyntra: !!localMyntraEl.checked,
    localAmazon: !!localAmazonEl.checked,
    proxyPeriodAmazon: pAmz,
    proxyPeriodMyntra: pMyn
  });
  chrome.runtime.sendMessage({ type: 'update-proxy-alarms' });
  localCheckStatus.style.color = 'var(--good)';
  localCheckStatus.textContent = 'Saved. Check Engine updated.';`;

const rep = `  const isAmz = !!localAmazonEl.checked;
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
  });

  localCheckStatus.style.color = 'var(--good)';
  localCheckStatus.textContent = 'Saved. Check Engine updated.';`;

code = code.replace(target, rep);

fs.writeFileSync('browser-extension/popup.js', code);
