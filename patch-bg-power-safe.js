const fs = require('fs');
let code = fs.readFileSync('browser-extension/background.js', 'utf8');

const target = `  if (stored.localAmazon || stored.localMyntra) {
    chrome.power.requestKeepAwake('system');
  } else {
    chrome.power.releaseKeepAwake();
  }`;

const rep = `  if (chrome.power) {
    if (stored.localAmazon || stored.localMyntra) {
      chrome.power.requestKeepAwake('system');
    } else {
      chrome.power.releaseKeepAwake();
    }
  }`;

code = code.replace(target, rep);

fs.writeFileSync('browser-extension/background.js', code);
