const { getDb } = require('./db');

// Replaces the old TELEGRAM_CHAT_ID / TELEGRAM_COMMAND_CHAT_ID env-var lists
// with a real, dashboard-managed list. Anyone who has ever messaged the bot
// gets a row here automatically (role NONE — no alerts) via recordSeen(),
// called from the webhook on every incoming message; a human then promotes
// them to OWNER or VIEWER from the admin page. `_id` is the chat id itself
// (a Telegram chat id is already unique per person for a private chat), so
// look-ups and upserts never need a separate id.
const ROLES = ['OWNER', 'VIEWER', 'NONE'];

async function recipientsCollection() {
  const db = await getDb();
  return db.collection('recipients');
}

/**
 * Called on every incoming webhook message, for every sender — not just the
 * admin chat. First time this chat id is seen, it's inserted at role NONE
 * (silently, no alerts) with `firstSeenAt`; every time after, just bumps
 * name/username/lastSeenAt in case they changed their Telegram profile.
 * Returns `isNew` so the webhook can send a one-time "you're noted" reply
 * instead of repeating it on every message.
 */
async function recordSeen(chatId, { name, username }) {
  const col = await recipientsCollection();
  const existing = await col.findOne({ _id: chatId }, { projection: { _id: 1 } });
  const now = new Date();
  await col.updateOne(
    { _id: chatId },
    {
      $set: { name, username: username || null, lastSeenAt: now },
      $setOnInsert: { chatId, role: 'NONE', firstSeenAt: now },
    },
    { upsert: true },
  );
  return { isNew: !existing };
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

async function setRole(chatId, role) {
  if (!ROLES.includes(role)) throw new Error(`Invalid role: ${role}`);
  const col = await recipientsCollection();
  const result = await col.updateOne({ _id: chatId }, { $set: { role } });
  if (result.matchedCount === 0) throw new Error('Recipient not found');
}

async function deleteRecipient(chatId) {
  const col = await recipientsCollection();
  await col.deleteOne({ _id: chatId });
}

/** The actual chat ids to send to for a given set of roles — what every alert-sending call reduces to. */
async function chatIdsForRoles(roles) {
  const col = await recipientsCollection();
  const docs = await col.find({ role: { $in: roles } }).project({ _id: 1 }).toArray();
  return docs.map((d) => d._id);
}

module.exports = { ROLES, recordSeen, listRecipients, setRole, deleteRecipient, chatIdsForRoles };
