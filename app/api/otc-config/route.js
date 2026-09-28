import { NextResponse } from 'next/server';
import { getDb } from '../../../lib/db';
import { requireOwner } from '../../../lib/adminAuth';
import { requireSection } from '../../../lib/access';
import {
  VALID_SCOPES,
  getOtcRecipientScope,
  setOtcRecipientScope,
  getOtcWindow,
  setOtcWindow,
  validateOtcWindow,
} from '../../../lib/otcConfig';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// OTC settings: who the alert goes to (recipientScope) and the daily check
// window in India time (window: { start, end } as "HH:MM", lib/otcConfig.js).
// Read by Overview (the OTC card's window) and Recipients (who gets the code).
export async function GET() {
  const access = await requireSection('overview', 'recipients');
  if (!access.ok) return NextResponse.json({ error: access.error }, { status: access.status });
  const db = await getDb();
  const [recipientScope, win] = await Promise.all([getOtcRecipientScope(db), getOtcWindow(db)]);
  return NextResponse.json({
    recipientScope,
    window: { start: win.start, end: win.end, isDefault: !!win.isDefault, updatedAt: win.updatedAt || null, updatedBy: win.updatedBy || null },
  });
}

// body: { recipientScope } and/or { window: { start, end } }.
// Changing the window is Owner-only (it decides when the bot calls Myntra).
// Who gets the OTC code needs Recipients (it used to be open to any login);
// the check window stays Owner only, below.
export async function PATCH(request) {
  const body = await request.json().catch(() => ({}));
  const hasScope = body.recipientScope !== undefined;
  const hasWindow = body.window !== undefined;
  const access = await requireSection(hasScope ? 'recipients' : 'overview');
  if (!access.ok) return NextResponse.json({ error: access.error }, { status: access.status });
  if (!hasScope && !hasWindow) {
    return NextResponse.json({ error: 'Nothing to change' }, { status: 400 });
  }
  if (hasScope && !VALID_SCOPES.includes(body.recipientScope)) {
    return NextResponse.json({ error: `recipientScope must be one of ${VALID_SCOPES.join(', ')}` }, { status: 400 });
  }

  let account = null;
  if (hasWindow) {
    const check = await requireOwner();
    if (!check.ok) return NextResponse.json({ error: check.error }, { status: check.status });
    account = check.account;
    const w = body.window || {};
    const error = validateOtcWindow(w.start, w.end);
    if (error) return NextResponse.json({ error }, { status: 400 });
  }

  const db = await getDb();
  const out = { ok: true };
  if (hasScope) {
    await setOtcRecipientScope(db, body.recipientScope);
    out.recipientScope = body.recipientScope;
  }
  if (hasWindow) {
    const win = await setOtcWindow(db, body.window.start, body.window.end, account && account.username);
    out.window = { start: win.start, end: win.end, updatedAt: win.updatedAt, updatedBy: win.updatedBy };
  }
  return NextResponse.json(out);
}
