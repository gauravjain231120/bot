const { MongoClient } = require('mongodb');

const dbName = process.env.MONGODB_DB || 'myntra_alerts';

// Lazy + cached across hot serverless invocations: must not connect at module-load
// time (Next.js's build step imports route modules to collect metadata, before env
// vars are necessarily present), only on the first actual request.
function getClientPromise() {
  if (!global._mongoClientPromise) {
    const uri = process.env.MONGODB_URI;
    if (!uri) throw new Error('MONGODB_URI is not set');
    global._mongoClientPromise = new MongoClient(uri).connect();
  }
  return global._mongoClientPromise;
}

async function getDb() {
  const client = await getClientPromise();
  return client.db(dbName);
}

module.exports = { getDb };
