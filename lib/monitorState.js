async function getRunning(db) {
  const doc = await db.collection('settings').findOne({ _id: 'status' });
  return Boolean(doc && doc.running);
}

async function setRunning(db, running) {
  await db.collection('settings').updateOne({ _id: 'status' }, { $set: { running } }, { upsert: true });
}

module.exports = { getRunning, setRunning };
