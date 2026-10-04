const { MongoClient } = require('mongodb');
require('dotenv').config({ path: '.env.local' });

async function run() {
  const client = new MongoClient(process.env.MONGODB_URI);
  try {
    await client.connect();
    const db = client.db();
    const all = await db.collection('settings').find({}).toArray();
    console.log(all);
  } finally {
    await client.close();
  }
}
run();
