const fs = require('fs');
let code = fs.readFileSync('browser-extension/background.js', 'utf8');

const target = `async function ensureProxyAlarms() {
  const stored = await chrome.storage.local.get(['localMyntra', 'localAmazon', 'proxyPeriodAmazon', 'proxyPeriodMyntra']);
  if (stored.localAmazon) {`;

const rep = `async function ensureProxyAlarms() {
  const stored = await chrome.storage.local.get(['localMyntra', 'localAmazon', 'proxyPeriodAmazon', 'proxyPeriodMyntra']);
  
  if (stored.localAmazon || stored.localMyntra) {
    chrome.power.requestKeepAwake('system');
  } else {
    chrome.power.releaseKeepAwake();
  }

  if (stored.localAmazon) {`;

code = code.replace(target, rep);

fs.writeFileSync('browser-extension/background.js', code);
