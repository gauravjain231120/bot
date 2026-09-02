import { NextResponse } from 'next/server';
import { isAuthed } from '../../../lib/adminAuth';
import { listSessionHistory } from '../../../lib/sessionHistory';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  if (!(await isAuthed())) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  const history = await listSessionHistory();
  return NextResponse.json({ history });
}
