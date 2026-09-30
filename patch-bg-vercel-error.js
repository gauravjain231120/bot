const fs = require('fs');
let code = fs.readFileSync('browser-extension/background.js', 'utf8');

const oldTestLocal = `
    const res = await fetch(\`\${appUrl}/api/proxy-test\`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-sync-secret': syncSecret },
      body: JSON.stringify({ marketplace, type: 'local', orders })
    });
    
    return await res.json();
  } catch (err) {
`;

const newTestLocal = `
    const res = await fetch(\`\${appUrl}/api/proxy-test\`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-sync-secret': syncSecret },
      body: JSON.stringify({ marketplace, type: 'local', orders })
    });
    
    const text = await res.text();
    try {
      return JSON.parse(text);
    } catch(e) {
      return { ok: false, error: 'Vercel server error (Deployment might be building)' };
    }
  } catch (err) {
`;

code = code.replace(oldTestLocal, newTestLocal);

const oldTestCloud = `
    const res = await fetch(\`\${appUrl}/api/proxy-test\`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-sync-secret': syncSecret },
      body: JSON.stringify({ marketplace, type: 'cloud' })
    });
    return await res.json();
  } catch (err) {
`;

const newTestCloud = `
    const res = await fetch(\`\${appUrl}/api/proxy-test\`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-sync-secret': syncSecret },
      body: JSON.stringify({ marketplace, type: 'cloud' })
    });
    
    const text = await res.text();
    try {
      return JSON.parse(text);
    } catch(e) {
      return { ok: false, error: 'Vercel server error (Deployment might be building)' };
    }
  } catch (err) {
`;

code = code.replace(oldTestCloud, newTestCloud);

fs.writeFileSync('browser-extension/background.js', code);
