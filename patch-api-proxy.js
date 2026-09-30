const fs = require('fs');
let code = fs.readFileSync('app/api/proxy-submit/route.js', 'utf8');

const target = `  const { marketplace, type, orders, canceledOrders } = body;

  try {
    const db = await getDb();
    if (canceledOrders) {`;

const replacement = `  const { marketplace, type, orders, canceledOrders, stateChange, interval } = body;

  try {
    const db = await getDb();
    
    if (interval) {
      await db.collection('settings').updateOne(
        { _id: 'status' },
        { $set: { [\`\${marketplace}ProxyInterval\`]: interval } },
        { upsert: true }
      );
    }

    if (stateChange === 'cloud') {
      const statusDoc = await db.collection('settings').findOne({ _id: 'status' }) || {};
      if (statusDoc[\`\${marketplace}ScrapeMode\`] === 'local') {
        const Name = marketplace === 'amazon' ? 'Amazon' : 'Myntra';
        await sendOwnerAlert(\`☁️ <b>\${Name} switched to Cloud Backup</b>\\nManual toggle turned OFF.\`, { silent: true }).catch(() => {});
      }
      await db.collection('settings').updateOne(
        { _id: 'status' },
        { $set: { [\`\${marketplace}ScrapeMode\`]: 'cloud', [\`\${marketplace}LastProxyCheck\`]: null } },
        { upsert: true }
      );
      return NextResponse.json({ ok: true, status: 'cloud-forced' });
    }

    if (canceledOrders) {`;

code = code.replace(target, replacement);

const missingImportTarget = `import { sendOwnerAlert } from '../../../../lib/telegram';`;
if (!code.includes('sendOwnerAlert')) {
  code = code.replace(
    `import { getDb } from '../../../../lib/db';`,
    `import { getDb } from '../../../../lib/db';\nimport { sendOwnerAlert } from '../../../../lib/telegram';`
  );
}

fs.writeFileSync('app/api/proxy-submit/route.js', code);
