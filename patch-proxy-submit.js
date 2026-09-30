const fs = require('fs');
let code = fs.readFileSync('app/api/proxy-submit/route.js', 'utf8');

const target = `  const { marketplace, type, orders } = body;

  try {
    if (type === 'test') {`;

const replacement = `  const { marketplace, type, orders, canceledOrders } = body;

  try {
    const db = await getDb();
    if (canceledOrders) {
      await db.collection('settings').updateOne(
        { _id: \`proxy_canceled_\${marketplace}\` },
        { $set: { data: canceledOrders, updatedAt: new Date().toISOString() } },
        { upsert: true }
      );
    }

    if (type === 'test') {`;

code = code.replace(target, replacement);

const missingImportTarget = `import { NextResponse } from 'next/server';
import { runCheckAmazonOrders } from '../../../../lib/checkAmazonOrders';`;

const missingImportReplacement = `import { NextResponse } from 'next/server';
import { getDb } from '../../../../lib/db';
import { runCheckAmazonOrders } from '../../../../lib/checkAmazonOrders';`;

if (!code.includes('import { getDb }')) {
  code = code.replace(missingImportTarget, missingImportReplacement);
}

fs.writeFileSync('app/api/proxy-submit/route.js', code);
