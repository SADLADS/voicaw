const db = require('./db');
const blocks = require('./blocks');
const { findUserByName } = require('./usernames');

// Friends (docs/client.md, Friends). The DM list shows your friends and whoever you have a
// conversation with, not everyone; friends are made by a request the other person accepts. A
// friendship is two `friends` rows (one from each side); a request waiting for an answer is a
// `friend_requests` row. Bots, accounts waiting for approval and deleted accounts can't be
// friends; blocking either way ends a friendship and its requests, and stops new ones. Admins
// can list everyone (the Friends page's Everyone tab), as everyone could before friends.
//
// Being friends isn't needed to DM someone (people in a guild together can, as in Discord):
// it only decides who's listed.

const now = () => Math.floor(Date.now() / 1000);

class FriendError extends Error {
  constructor(status, message, code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

// `userId`'s friends and requests: { friends: [{ id, since }], incoming: [{ id, created_at }],
// outgoing: [{ id, created_at }] }, newest first.
async function relationships(userId) {
  const [friends, incoming, outgoing] = await Promise.all([
    db.all('SELECT friend_id AS id, created_at AS since FROM friends WHERE user_id = ? ORDER BY created_at DESC, friend_id', [userId]),
    db.all('SELECT from_id AS id, created_at FROM friend_requests WHERE to_id = ? ORDER BY created_at DESC, from_id', [userId]),
    db.all('SELECT to_id AS id, created_at FROM friend_requests WHERE from_id = ? ORDER BY created_at DESC, to_id', [userId]),
  ]);
  return { friends, incoming, outgoing };
}

// What GET /friends and the `friends` event send `userId`: their relationships, and `admin`
// (the app shows admins the Everyone tab).
async function listFor(userId) {
  const admin = Boolean((await db.get('SELECT is_admin FROM users WHERE id = ?', [userId]))?.is_admin);
  return { ...(await relationships(userId)), admin };
}

async function areFriends(a, b) {
  return Boolean(await db.get('SELECT 1 FROM friends WHERE user_id = ? AND friend_id = ?', [a, b]));
}

// Someone who can be asked: a person (not a bot) with an account in use.
async function findPerson(id) {
  return db.get('SELECT id FROM users WHERE id = ? AND bot = 0 AND pending = 0 AND deleted_at IS NULL', [id]);
}

// `userId` asks `otherId` to be friends, or accepts their request if they've already asked.
// Resolves to 'requested', 'accepted' or 'friends' (already were). Throws FriendError.
async function request(userId, otherId) {
  if (otherId === userId) throw new FriendError(400, "You can't add yourself", 'self');
  if (!(await findPerson(otherId))) throw new FriendError(404, 'User not found', 'not_found');
  // As with DMs, not saying who blocked whom.
  if (await blocks.blockedBetween(userId, otherId)) {
    throw new FriendError(403, "Your friend request couldn't be sent", 'blocked');
  }
  return db.transaction(async () => {
    if (await areFriends(userId, otherId)) return 'friends';
    const theirs = await db.get('SELECT 1 FROM friend_requests WHERE from_id = ? AND to_id = ?', [otherId, userId]);
    if (!theirs) {
      await db.run(
        'INSERT INTO friend_requests (from_id, to_id, created_at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING',
        [userId, otherId, now()]
      );
      return 'requested';
    }
    const at = now();
    await db.run('DELETE FROM friend_requests WHERE (from_id = ? AND to_id = ?) OR (from_id = ? AND to_id = ?)', [userId, otherId, otherId, userId]);
    await db.run('INSERT OR IGNORE INTO friends (user_id, friend_id, created_at) VALUES (?, ?, ?), (?, ?, ?)', [userId, otherId, at, otherId, userId, at]);
    return 'accepted';
  });
}

// The same by username (the Add Friend box).
async function requestByName(userId, username) {
  const name = typeof username === 'string' ? username.trim() : '';
  if (!name) throw new FriendError(400, 'Enter a username', 'invalid');
  const user = await findUserByName(name, 'id');
  if (!user) throw new FriendError(404, 'User not found', 'not_found');
  return { id: user.id, result: await request(userId, user.id) };
}

// Ends whatever is between the two: a friendship, or a request either way (declining,
// cancelling). True if there was something.
async function remove(userId, otherId) {
  return db.transaction(async () => {
    const a = await db.run('DELETE FROM friends WHERE (user_id = ? AND friend_id = ?) OR (user_id = ? AND friend_id = ?)', [userId, otherId, otherId, userId]);
    const b = await db.run('DELETE FROM friend_requests WHERE (from_id = ? AND to_id = ?) OR (from_id = ? AND to_id = ?)', [userId, otherId, otherId, userId]);
    return a.changes + b.changes > 0;
  });
}

module.exports = { FriendError, relationships, listFor, areFriends, request, requestByName, remove };
