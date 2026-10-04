const { sendOwnerAlert } = require('./telegram');

// Checks that keep failing for a reason that ISN'T the session (Myntra/Amazon
// 5xx, timeouts, DNS…) used to show only on the dashboard — nobody was told
// that orders weren't being checked. One owner alert per streak; the first
// good check resets it.
const STREAKS = {
  myntra: { field: 'myntraFailStreak', flag: 'myntraFailAlertSent', label: 'Myntra', limit: 15, every: '2 min' }, // ~30 min
  amazon: { field: 'amazonFailStreak', flag: 'amazonFailAlertSent', label: 'Amazon', limit: 6, every: '5 min' }, // ~30 min
  flipkart: { field: 'flipkartFailStreak', flag: 'flipkartFailAlertSent', label: 'Flipkart', limit: 6, every: '5 min' },
};

async function noteCheckFailure(settings, which, errorText) {
  const { field, flag, label, limit } = STREAKS[which];
  try {
    const doc = await settings.findOneAndUpdate({ _id: 'status' }, { $inc: { [field]: 1 } }, { upsert: true, returnDocument: 'after' });
    if (!doc || doc[field] < limit || doc[flag]) return;
    const claimed = await settings.findOneAndUpdate({ _id: 'status', [flag]: { $ne: true } }, { $set: { [flag]: true } }, { returnDocument: 'after' });
    if (!claimed) return;
    const res = await sendOwnerAlert(
      `⚠️ <b>${label} order checks keep failing</b> (${doc[field]} in a row, ~${Math.round((doc[field] * (which === 'myntra' ? 2 : 5)))} min)\n` +
        `Last error: ${String(errorText).slice(0, 200)}\nNew orders aren't being picked up until this clears.`
    ).catch(() => ({ sent: 0 }));
    if (res && res.sent === 0) await settings.updateOne({ _id: 'status' }, { $set: { [flag]: false } });
  } catch (err) {
    console.error('failure-streak update failed:', err.message);
  }
}

function checkOkFields(which) {
  const { field, flag } = STREAKS[which];
  return { [field]: 0, [flag]: false };
}

module.exports = { noteCheckFailure, checkOkFields };
