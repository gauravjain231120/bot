const { cookies } = require('next/headers');

async function isAuthed() {
  const jar = await cookies();
  const value = jar.get('admin_auth')?.value;
  return Boolean(process.env.ADMIN_PASSWORD) && value === process.env.ADMIN_PASSWORD;
}

module.exports = { isAuthed };
