import { NextResponse } from 'next/server';
import { getDb } from '../../../lib/db';
import { isAuthed } from '../../../lib/adminAuth';
import { VALID_SCOPES, getOtcRecipientScope, setOtcRecipientScope } from '../../../lib/otcConfig';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  if (!(await isAuthed())) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  const db = await getDb();
  const recipientScope = await getOtcRecipientScope(db);
  return NextResponse.json({ recipientScope });
}

export async function PATCH(request) {
  if (!(await isAuthed())) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  const body = await request.json().catch(() => ({}));
  if (!VALID_SCOPES.includes(body.recipientScope)) {
    return NextResponse.json({ error: `recipientScope must be one of ${VALID_SCOPES.join(', ')}` }, { status: 400 });
  }
  const db = await getDb();
  await setOtcRecipientScope(db, body.recipientScope);
  return NextResponse.json({ ok: true, recipientScope: body.recipientScope });
}
