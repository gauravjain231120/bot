const { sendOwnerAlert } = require('./telegram');

// Every scheduled check notes when it last ran (even while monitoring is
// stopped), and the checks watch each other: if one goes quiet — the
// scheduler (cron-job.org) paused or disabled it, its URL/secret changed —
// the owner hears about it once, instead of orders silently going unchecked
// while the dashboard still looks fine. Only jobs that have ticked at least
// once since this was added are watched (a job that was never scheduled
// isn't "stopped").

const JOBS = {
  orders: { field: 'tickOrdersAt', label: 'Myntra order check (/api/check-orders)', staleMin: 15 },
  amazonOrders: { field: 'tickAmazonOrdersAt', label: 'Amazon order check (/api/check-amazon-orders)', staleMin: 25 },
  cancellations: { field: 'tickCancellationsAt', label: 'Myntra cancellation check (/api/check-cancellations)', staleMin: 25 },
  amazonCancellations: { field: 'tickAmazonCancellationsAt', label: 'Amazon cancellation check (/api/check-amazon-cancellations)', staleMin: 100 },
  otc: { field: 'tickOtcAt', label: 'OTC check (/api/check-otc)', staleMin: 15 },
};

async function recordTick(db, job) {
  await db.collection('settings').updateOne({ _id: 'status' }, { $set: { [JOBS[job].field]: new Date().toISOString() } }, { upsert: true });
}

/** Alert (once per silence) for any of `jobs` that stopped ticking. Never throws. */
async function checkTicks(db, jobs) {
  try {
    const settings = db.collection('settings');
    const st = (await settings.findOne({ _id: 'status' })) || {};
    for (const job of jobs) {
      const { field, label, staleMin } = JOBS[job];
      const flag = `${field}Alerted`;
      if (!st[field]) continue;
      const ageMin = (Date.now() - new Date(st[field]).getTime()) / 60000;
      if (ageMin < staleMin) {
        if (st[flag]) await settings.updateOne({ _id: 'status' }, { $set: { [flag]: false } });
        continue;
      }
      if (st[flag]) continue;
      // Claimed before sending — the other checks watch the same job and run
      // at the same moments; only one of them may send this.
      const claimed = await settings.findOneAndUpdate({ _id: 'status', [flag]: { $ne: true } }, { $set: { [flag]: true } }, { returnDocument: 'after' });
      if (!claimed) continue;
      const res = await sendOwnerAlert(
        `⚠️ <b>A scheduled check has stopped running</b>\n${label} last ran ${Math.round(ageMin)} min ago.\n` +
          `Check that the job is still enabled on cron-job.org (it may have been switched off after errors).`
      ).catch(() => ({ sent: 0 }));
      if (!res || !(res.sent > 0)) await settings.updateOne({ _id: 'status' }, { $set: { [flag]: false } });
    }
  } catch (err) {
    console.error('cron watchdog failed:', err.message);
  }
}

module.exports = { recordTick, checkTicks, JOBS };
