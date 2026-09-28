import { NextResponse } from 'next/server';
import { requireOwner } from '../../../../lib/adminAuth';
import { ROLES, deleteAccount, setAccountRole, setAccountSections } from '../../../../lib/accounts';
import { secretMatches } from '../../../../lib/secrets';
import { cleanSections } from '../../../../lib/sections';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Same confirmation-password pattern as app/api/accounts/route.js (POST) and
// the Telegram recipients routes — one shared ROLE_CHANGE_PASSWORD for any
// change to who has dashboard access or what they can do with it.
function checkConfirmPassword(body) {
  return secretMatches(body.confirmPassword, process.env.ROLE_CHANGE_PASSWORD);
}

/**
 * PATCH { role, confirmPassword } -> change an existing account's role, or
 * PATCH { sections, confirmPassword } -> change what a Viewer may open
 * (lib/sections.js keys; unknown ones dropped). Owner only.
 */
export async function PATCH(request, { params }) {
  const check = await requireOwner();
  if (!check.ok) return NextResponse.json({ error: check.error }, { status: check.status });

  const { username } = await params;
  const body = await request.json().catch(() => ({}));
  const settingSections = Array.isArray(body.sections);

  if (!settingSections && !ROLES.includes(body.role)) {
    return NextResponse.json({ error: `role must be one of ${ROLES.join(', ')}` }, { status: 400 });
  }
  if (!checkConfirmPassword(body)) {
    return NextResponse.json({ error: 'Wrong confirmation password' }, { status: 403 });
  }

  try {
    const account = settingSections ? await setAccountSections(username, cleanSections(body.sections)) : await setAccountRole(username, body.role);
    return NextResponse.json({ ok: true, account });
  } catch (err) {
    const status = err.message === 'Account not found' ? 404 : err.message.includes('protected') ? 403 : 400;
    return NextResponse.json({ error: err.message }, { status });
  }
}

export async function DELETE(request, { params }) {
  const check = await requireOwner();
  if (!check.ok) return NextResponse.json({ error: check.error }, { status: check.status });

  const body = await request.json().catch(() => ({}));
  if (!checkConfirmPassword(body)) {
    return NextResponse.json({ error: 'Wrong confirmation password' }, { status: 403 });
  }

  const { username } = await params;
  try {
    await deleteAccount(username);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json({ error: err.message }, { status: 400 });
  }
}
