const db = require('./db');

// Usernames are lower case and ignore capitals everywhere (logging in, recovery, making an
// admin). Someone who signs up as "Alice" gets the username "alice" and the display name
// "Alice". Migration 5 (db.js) did the same for accounts from before.
//
// OPAQUE derives each account's server-side key from the name the password was registered
// under, so `users.opaque_id` keeps the old spelling for accounts that were renamed, until
// their next password change or recovery re-registers them under the lower-case name.

const normalizeUsername = (name) => String(name).toLowerCase();

// What new usernames may be (security audit, 2026-11-18): 2 to 32 of a-z, 0-9, _, - and . (no two
// dots running), after lower-casing, so no spaces, invisible characters or look-alike letters
// can pass one person off as another. Only sign-ups are checked: accounts from before keep
// their names and log in as always ('#' was already refused, being kept for bots' names).
const USERNAME_RULE = /^(?!.*\.\.)[a-z0-9_.-]{2,32}$/;
const isValidNewUsername = (name) => typeof name === 'string' && USERNAME_RULE.test(normalizeUsername(name));

// The user called `name` (any capitals), with `columns`, or undefined (also for deleted accounts
// and bots, which can't log in: bots.js). An exact match wins: the
// migration left an account's capitals alone when lower-casing would have clashed with another.
async function findUserByName(name, columns) {
  if (typeof name !== 'string' || !name) return undefined;
  const sql = `SELECT ${columns} FROM users WHERE username = ? AND deleted_at IS NULL AND bot = 0`;
  return (await db.get(sql, [name])) ?? (await db.get(sql, [normalizeUsername(name)]));
}

// The identifier `user`'s OPAQUE registration record is bound to.
const opaqueIdOf = (user) => user.opaque_id ?? user.username;

// users.opaque_id for a password just registered (under the normalised name) for `username`.
const newOpaqueId = (username) => (normalizeUsername(username) === username ? null : normalizeUsername(username));

module.exports = { normalizeUsername, isValidNewUsername, findUserByName, opaqueIdOf, newOpaqueId };
