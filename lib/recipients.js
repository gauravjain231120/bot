const { getDb } = require('./db');

// Replaces the old TELEGRAM_CHAT_ID / TELEGRAM_COMMAND_CHAT_ID env-var lists
// with a real, dashboard-managed list. Anyone who has ever messaged the bot
// gets a row here automatically (role NONE — no alerts) via recordSeen(),
// called from the webhook on every incoming message; a human then promotes
// them to OWNER or VIEWER from the admin page. `_id` is the chat id itself
// (a Telegram chat id is already unique per person for a private chat), so
// look-ups and upserts never need a separate id.
//
// `protected: true` marks the one seeded, founding Owner (Gaurav) — hidden
// from the dashboard's own list and refused by setRole/deleteRecipient, so
// there's no way to demote or remove yourself through this UI and lock
// everyone out. Promoting OTHER people to Owner is unaffected — only this
// one row is fixed.
const ROLES = ['OWNER', 'VIEWER', 'NONE'];

async function recipientsCollection() {
  const db = await getDb();
  return db.collection('recipients');
}

async function historyCollection() {
  const db = await getDb();
  return db.collection('recipientRoleHistory');
}

/**
 * Called on every incoming webhook message, for every sender — not just the
 * admin chat. First time this chat id is seen, it's inserted at role NONE
 * (silently, no alerts) with `firstSeenAt`; every time after, just bumps
 * name/username/lastSeenAt in case they changed their Telegram profile —
 * this is what keeps names "always from Telegram" for anyone who's actively
 * messaging the bot. Returns `isNew` (for the one-time welcome reply) and
 * the chat's current `role` (so the webhook can gate commands on it without
 * a second DB round-trip).
 */
async function recordSeen(chatId, { name, username }) {
  const col = await recipientsCollection();
  const existing = await col.findOne({ _id: chatId }, { projection: { role: 1 } });
  const now = new Date();
  await col.updateOne(
    { _id: chatId },
    {
      $set: { name, username: username || null, lastSeenAt: now },
      $setOnInsert: { chatId, role: 'NONE', protected: false, firstSeenAt: now },
    },
    { upsert: true },
  );
  return { isNew: !existing, role: existing ? existing.role : 'NONE' };
}

// Owner first, then Viewer, then everyone still unassigned — so the
// dashboard reads as "who matters most" without the admin having to sort it
// themselves. Ties broken by most-recently-active first.
const ROLE_SORT_RANK = { OWNER: 0, VIEWER: 1, NONE: 2 };

async function listRecipients() {
  const col = await recipientsCollection();
  const docs = await col.find({}).toArray();
  docs.sort((a, b) => {
    const rank = (ROLE_SORT_RANK[a.role] ?? 9) - (ROLE_SORT_RANK[b.role] ?? 9);
    if (rank !== 0) return rank;
    return new Date(b.lastSeenAt || 0) - new Date(a.lastSeenAt || 0);
  });
  return docs;
}

async function getRecipient(chatId) {
  const col = await recipientsCollection();
  return col.findOne({ _id: chatId });
}

/**
 * Changes a recipient's role and logs the transition to history (skipped if
 * the role didn't actually change, e.g. clicking the already-active button).
 * Refuses on the protected founding-Owner row — see the module comment.
 */
async function setRole(chatId, role) {
  if (!ROLES.includes(role)) throw new Error(`Invalid role: ${role}`);
  const col = await recipientsCollection();
  const existing = await col.findOne({ _id: chatId });
  if (!existing) throw new Error('Recipient not found');
  if (existing.protected) throw new Error('This recipient is protected and cannot be changed here');

  if (existing.role === role) return; // no-op, nothing to log

  await col.updateOne({ _id: chatId }, { $set: { role } });

  const hist = await historyCollection();
  await hist.insertOne({
    chatId,
    name: existing.name || chatId,
    fromRole: existing.role,
    toRole: role,
    changedAt: new Date(),
  });
}

/**
 * Removes a recipient from the manageable list. Their role-change history is
 * deliberately NOT touched — a separate collection, kept forever as an audit
 * trail regardless of whether the person is still in the live list.
 */
async function deleteRecipient(chatId) {
  const col = await recipientsCollection();
  const existing = await col.findOne({ _id: chatId });
  if (existing && existing.protected) throw new Error('This recipient is protected and cannot be removed');
  await col.deleteOne({ _id: chatId });
}

/** Overwrites just the Telegram-sourced profile fields — used by the dashboard's Refresh action. */
async function updateProfile(chatId, { name, username }) {
  const col = await recipientsCollection();
  await col.updateOne({ _id: chatId }, { $set: { name, username: username || null } });
}

/** Raw DB doc -> what the dashboard actually renders. Shared by the list and refresh routes. */
function toPublicShape(doc) {
  return {
    chatId: doc._id,
    name: doc.name || null,
    username: doc.username || null,
    role: doc.role,
    firstSeenAt: doc.firstSeenAt || null,
    lastSeenAt: doc.lastSeenAt || null,
  };
}

async function listRoleHistory(limit = 200) {
  const hist = await historyCollection();
  return hist.find({}).sort({ changedAt: -1 }).limit(limit).toArray();
}

/** The actual chat ids to send to for a given set of roles — what every alert-sending call reduces to. */
async function chatIdsForRoles(roles) {
  const col = await recipientsCollection();
  const docs = await col.find({ role: { $in: roles } }).project({ _id: 1 }).toArray();
  return docs.map((d) => d._id);
}

module.exports = {
  ROLES,
  recordSeen,
  listRecipients,
  getRecipient,
  setRole,
  deleteRecipient,
  updateProfile,
  listRoleHistory,
  chatIdsForRoles,
  toPublicShape,
};
