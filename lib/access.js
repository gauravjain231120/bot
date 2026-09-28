import { getCurrentAccount } from './adminAuth';
import { canAccess } from './sections';

/**
 * API-route guard for the per-person sections (lib/sections.js): the account
 * must be logged in and may open at least one of `keys`. Owners pass always.
 *   const check = await requireSection('myntraPack');
 *   if (!check.ok) return NextResponse.json({ error: check.error }, { status: check.status });
 * A plain object, not a response — route handlers build that themselves.
 */
export async function requireSection(...keys) {
  const account = await getCurrentAccount();
  if (!account) return { ok: false, status: 401, error: 'unauthorized' };
  if (!keys.some((k) => canAccess(account, k))) {
    return { ok: false, status: 403, error: "You don't have access to this — ask the Owner to give it to you on the Team page." };
  }
  return { ok: true, account };
}
