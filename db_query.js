const { MongoClient } = require('mongodb');
require('dotenv').config({ path: '.env.local' });

async function run() {
  const client = new MongoClient(process.env.MONGODB_URI);
  try {
    await client.connect();
    const db = client.db();
    const all = await db.collection('flipkart_seen_orders').find({}).toArray();
    console.log("Seen Orders:", all.length);
    console.log(JSON.stringify(all, null, 2));
  } finally {
    await client.close();
  }
}
run();
