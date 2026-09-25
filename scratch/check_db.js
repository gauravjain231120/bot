const { MongoClient } = require('mongodb');
require('dotenv').config({ path: '.env.local' });
require('dotenv').config({ path: '.env' });

async function check() {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    console.log("No MONGODB_URI found.");
    return;
  }
  const client = new MongoClient(uri);
  await client.connect();
  const db = client.db();
  
  const status = await db.collection('settings').findOne({ _id: 'status' });
  console.log("STATUS DOC:", JSON.stringify(status, null, 2));

  const session = await db.collection('settings').findOne({ _id: 'session' });
  console.log("SESSION DOC:", session ? "Exists (keys: " + Object.keys(session).join(',') + ")" : "Missing");

  await client.close();
}
check().catch(console.error);
