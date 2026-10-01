const db = require('./db');

// Usernames are lower case and ignore capitals everywhere (logging in, recovery, making an
// admin). Someone who signs up as "Alice" gets the username "alice" and the display name
// "Alice". Migration 5 (db.js) did the same for accounts from before.
//
// OPAQUE derives each account's server-side key from the name the password was registered
// under, so `users.opaque_id` keeps the old spelling for accounts that were renamed, until
// their next password change or recovery re-registers them under the lower-case name.

const normalizeUsername = (name) => String(name).toLowerCase();

// The user called `name` (any capitals), with `columns`, or undefined (also for deleted accounts). An exact match wins: the
// migration left an account's capitals alone when lower-casing would have clashed with another.
async function findUserByName(name, columns) {
  if (typeof name !== 'string' || !name) return undefined;
  const sql = `SELECT ${columns} FROM users WHERE username = ? AND deleted_at IS NULL`;
  return (await db.get(sql, [name])) ?? (await db.get(sql, [normalizeUsername(name)]));
}

// The identifier `user`'s OPAQUE registration record is bound to.
const opaqueIdOf = (user) => user.opaque_id ?? user.username;

// users.opaque_id for a password just registered (under the normalised name) for `username`.
const newOpaqueId = (username) => (normalizeUsername(username) === username ? null : normalizeUsername(username));

module.exports = { normalizeUsername, findUserByName, opaqueIdOf, newOpaqueId };
