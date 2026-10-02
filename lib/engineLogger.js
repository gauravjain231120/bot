const { getDb } = require('./db');

let indexCreated = false;

async function logEngineEvent(marketplace, type, message) {
  try {
    const db = await getDb();
    const collection = db.collection('engineLogs');
    
    if (!indexCreated) {
      await collection.createIndex({ createdAt: 1 }, { expireAfterSeconds: 2592000 }).catch(() => {});
      indexCreated = true;
    }
    
    await collection.insertOne({
      marketplace,
      type,
      message,
      createdAt: new Date()
    });
  } catch (err) {
    console.error('Failed to log engine event:', err.message);
  }
}

module.exports = { logEngineEvent };
