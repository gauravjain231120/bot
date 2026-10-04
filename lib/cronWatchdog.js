const { sendOwnerAlert } = require('./telegram');
const { getOtcWindow } = require('./otcConfig');

// Every scheduled check notes when it last ran (even while monitoring is
// stopped), and the checks watch each other: if one goes quiet — the
// scheduler (cron-job.org) paused or disabled it, its URL/secret changed —
// the owner hears about it once, instead of orders silently going unchecked
// while the dashboard still looks fine. Only jobs that have ticked at least
// once since this was added are watched (a job that was never scheduled
// isn't "stopped").

const JOBS = {
  orders: { field: 'tickOrdersAt', label: 'Myntra order check (/api/check-orders)', staleMin: 15, marketplace: 'myntra' },
  amazonOrders: { field: 'tickAmazonOrdersAt', label: 'Amazon order check (/api/check-amazon-orders)', staleMin: 25, marketplace: 'amazon' },
  cancellations: { field: 'tickCancellationsAt', label: 'Myntra cancellation check (/api/check-cancellations)', staleMin: 25, marketplace: 'myntra' },
  flipkartOrders: { field: 'tickFlipkartOrdersAt', label: 'Flipkart order check (/api/check-flipkart-orders)', staleMin: 25, marketplace: 'flipkart' },
  amazonCancellations: { field: 'tickAmazonCancellationsAt', label: 'Amazon cancellation check (/api/check-amazon-cancellations)', staleMin: 100, marketplace: 'amazon' },
  // Only has work inside the OTC window (set on the dashboard, India time), so
  // cron-job.org may call it only around then — watched only inside it.
  otc: { field: 'tickOtcAt', label: 'OTC check (/api/check-otc)', staleMin: 15, duringOtcWindow: true },
};

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

// Should `job` have ticked lately, right now? Always — except the OTC check:
// from `staleMin` into its window until the window ends (a first tick of the
// day, due at the window's start, isn't missing yet at 12:01).
async function expectedNow(db, job, now = Date.now()) {
  const { duringOtcWindow, staleMin, marketplace } = JOBS[job];

  // When the browser extension is handling this marketplace locally,
  // the cloud cron is expected to be idle — don't alert about it.
  if (marketplace) {
    const st = (await db.collection('settings').findOne({ _id: 'status' })) || {};
    if (st[`${marketplace}ScrapeMode`] === 'local') return false;
  }

  if (!duringOtcWindow) return true;
  const win = await getOtcWindow(db);
  const ist = new Date(now + IST_OFFSET_MS);
  const m = ist.getUTCHours() * 60 + ist.getUTCMinutes();
  return m >= win.startMin + staleMin && m < win.endMin;
}

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
      if (!(await expectedNow(db, job))) continue;
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

module.exports = { recordTick, checkTicks, expectedNow, JOBS };
