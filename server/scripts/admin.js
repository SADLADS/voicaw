// Makes a user a global admin (Settings → Admin), or with --remove takes it away:
//   cd server && npm run admin -- <username> [--remove]
// or turns off their two-factor (they lost both the authenticator app and the backup codes):
//   cd server && npm run admin -- <username> --remove-two-factor
// Uses DB_PATH like the server (default ./voicaw.db, so run it from server/). Once there's
// one admin, they can add others in the app.
require('dotenv').config({ quiet: true });
const db = require('../db');
const { findUserByName } = require('../usernames');

async function main() {
  const args = process.argv.slice(2);
  const remove = args.includes('--remove');
  const removeTwoFactor = args.includes('--remove-two-factor');
  const username = args.find((a) => !a.startsWith('--'));
  if (!username) {
    console.error('Usage: npm run admin -- <username> [--remove | --remove-two-factor]');
    process.exit(1);
  }
  const user = await findUserByName(username, 'id');
  if (!user) {
    console.error(`No user called ${username}`);
    process.exit(1);
  }
  if (removeTwoFactor) {
    await require('../twoFactor').disable(user.id);
    console.log(`Two-factor is off for ${username}`);
    db.db.close();
    return;
  }
  await db.run('UPDATE users SET is_admin = ? WHERE id = ?', [remove ? 0 : 1, user.id]);
  console.log(remove ? `${username} is no longer an admin` : `${username} is now an admin`);
  db.db.close();
}

main();
