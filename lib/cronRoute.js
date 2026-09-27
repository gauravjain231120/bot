const { NextResponse } = require('next/server');
const { secretMatches } = require('./secrets');

// Shared by the /api/check-* routes (called by cron-job.org).

function cronAuthorized(request) {
  return secretMatches(request.nextUrl.searchParams.get('secret'), process.env.CRON_SECRET);
}

// A failure the check already handled — marketplace said no, session expired,
// no session saved — is recorded (dashboard) and alerted (Telegram) by the
// check itself. Answering it with an HTTP error only made cron-job.org count
// failures, and enough of them can switch the job off for good (then nothing
// checks orders at all). So: 200 with ok:false. Anything unexpected (the
// database down, a bug) still answers 500.
function cronFailure(err) {
  const handled = !!err.status || /session|No .*session saved/i.test(String(err.message));
  return NextResponse.json({ ok: false, error: err.message }, { status: handled ? 200 : 500 });
}

module.exports = { cronAuthorized, cronFailure };
