// A tiny, dedicated settings accessor for one preference: who the OTC
// success alert (§19) goes to. Same "own settings doc" pattern as
// lib/monitorState.js's running flag — kept separate from lib/recipients.js
// since this isn't a per-person role, it's a single global routing choice.
const VALID_SCOPES = ['OWNER', 'BROADCAST'];
const DEFAULT_SCOPE = 'OWNER'; // matches the feature's original, unconfigurable behavior

async function getOtcRecipientScope(db) {
  const doc = await db.collection('settings').findOne({ _id: 'otc_config' });
  const scope = doc && doc.recipientScope;
  return VALID_SCOPES.includes(scope) ? scope : DEFAULT_SCOPE;
}

async function setOtcRecipientScope(db, scope) {
  if (!VALID_SCOPES.includes(scope)) throw new Error(`Invalid scope: ${scope}`);
  await db.collection('settings').updateOne({ _id: 'otc_config' }, { $set: { recipientScope: scope } }, { upsert: true });
}

module.exports = { VALID_SCOPES, DEFAULT_SCOPE, getOtcRecipientScope, setOtcRecipientScope };
