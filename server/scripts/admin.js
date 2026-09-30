// Makes a user a global admin (Settings → Admin), or with --remove takes it away:
//   cd server && npm run admin -- <username> [--remove]
// Uses DB_PATH like the server (default ./voicaw.db, so run it from server/). Once there's
// one admin, they can add others in the app.
require('dotenv').config({ quiet: true });
const db = require('../db');

async function main() {
  const args = process.argv.slice(2);
  const remove = args.includes('--remove');
  const username = args.find((a) => !a.startsWith('--'));
  if (!username) {
    console.error('Usage: npm run admin -- <username> [--remove]');
    process.exit(1);
  }
  const { changes } = await db.run('UPDATE users SET is_admin = ? WHERE username = ?', [remove ? 0 : 1, username]);
  if (!changes) {
    console.error(`No user called ${username}`);
    process.exit(1);
  }
  console.log(remove ? `${username} is no longer an admin` : `${username} is now an admin`);
  db.db.close();
}

main();
