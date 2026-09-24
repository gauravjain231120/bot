const { MongoClient } = require('mongodb');

const dbName = process.env.MONGODB_DB || 'myntra_alerts';

// Lazy + cached across hot serverless invocations: must not connect at module-load
// time (Next.js's build step imports route modules to collect metadata, before env
// vars are necessarily present), only on the first actual request.
//
// A FAILED connect must not be cached: it used to stay in the global as a
// rejected promise, so one network blip at connect time broke every request
// on that warm server instance until it happened to be recycled. Now the cache
// is cleared on failure and the next request simply connects again. 8s server
// selection (not the driver's 30s default) makes an unreachable database fail
// fast instead of eating most of a cron run.
const CONNECT_OPTIONS = { serverSelectionTimeoutMS: 8000, connectTimeoutMS: 8000 };

function getClientPromise() {
  if (!global._mongoClientPromise) {
    const uri = process.env.MONGODB_URI;
    if (!uri) throw new Error('MONGODB_URI is not set');
    global._mongoClientPromise = new MongoClient(uri, CONNECT_OPTIONS).connect().catch((err) => {
      global._mongoClientPromise = null;
      throw err;
    });
  }
  return global._mongoClientPromise;
}

async function getDb() {
  const client = await getClientPromise();
  return client.db(dbName);
}

module.exports = { getDb };
