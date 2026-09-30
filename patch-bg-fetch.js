const fs = require('fs');
let code = fs.readFileSync('browser-extension/background.js', 'utf8');

// Replace the old fetchWithRetry
const oldFetch = `async function fetchWithRetry(url, maxTries = 2) {
  let lastErr;
  for (let i = 0; i < maxTries; i++) {
    try {
      const res = await fetch(url);
      if (res.status === 401 || res.status === 403) return null;
      return await res.json();
    } catch (e) {
      lastErr = e;
      await new Promise(r => setTimeout(r, 1000));
    }
  }
  return null;
}`;

const newFetch = `async function fetchWithRetry(url, maxTries = 2) {
  let lastErr;
  for (let i = 0; i < maxTries; i++) {
    try {
      const res = await fetch(url, { credentials: 'include' });
      if (res.status === 401 || res.status === 403) return { _error: \`HTTP \${res.status} Unauthorized (Check login)\` };
      
      const text = await res.text();
      try {
        return JSON.parse(text);
      } catch (e) {
        if (text.toLowerCase().includes('sign in') || text.toLowerCase().includes('login')) {
           return { _error: 'Received a Sign-In page. Please log in to this marketplace in Chrome.' };
        }
        return { _error: 'Received HTML instead of JSON. Marketplace might be showing a Captcha/Bot page.' };
      }
    } catch (e) {
      lastErr = e;
      await new Promise(r => setTimeout(r, 1000));
    }
  }
  return { _error: lastErr ? lastErr.message : 'Network error' };
}`;

code = code.replace(oldFetch, newFetch);

// Update handleTestLocal to use the new _error field for better UI feedback
const oldAmzFetch = `
      const amzUrl = 'https://sellercentral.amazon.in/orders-api/search?limit=100&offset=0&sort=status_desc&date-range=last-7&fulfillmentType=mfn&orderStatus=unshipped&forceOrdersTableRefreshTrigger=false&isSearchQuery=true&programs=easyship';
      const data = await fetchWithRetry(amzUrl);
      if (data && Array.isArray(data.orders)) orders = data.orders;
      else return { ok: false, error: 'Could not fetch from Amazon' };
`;

const newAmzFetch = `
      const amzUrl = 'https://sellercentral.amazon.in/orders-api/search?limit=100&offset=0&sort=status_desc&date-range=last-7&fulfillmentType=mfn&orderStatus=unshipped&forceOrdersTableRefreshTrigger=false&isSearchQuery=true&programs=easyship';
      const data = await fetchWithRetry(amzUrl);
      if (data && data._error) return { ok: false, error: data._error };
      if (data && Array.isArray(data.orders)) orders = data.orders;
      else return { ok: false, error: 'Could not parse Amazon orders array' };
`;

code = code.replace(oldAmzFetch, newAmzFetch);

const oldMynFetch = `
      const data = await fetchWithRetry(mynUrl);
      orders = extractMyntraOrders(data);
      if (!orders) return { ok: false, error: 'Could not fetch from Myntra' };
`;

const newMynFetch = `
      const data = await fetchWithRetry(mynUrl);
      if (data && data._error) return { ok: false, error: data._error };
      orders = extractMyntraOrders(data);
      if (!orders) return { ok: false, error: 'Could not extract Myntra orders' };
`;

code = code.replace(oldMynFetch, newMynFetch);

fs.writeFileSync('browser-extension/background.js', code);
