require('dotenv').config({ path: '.env.local' });
const { MongoClient } = require('mongodb');

async function check() {
  const client = new MongoClient(process.env.MONGODB_URI);
  await client.connect();
  const db = client.db(process.env.MONGODB_DB);
  const status = await db.collection('settings').findOne({ _id: 'status' });
  console.log(JSON.stringify(status, null, 2));
  await client.close();
}
check();
