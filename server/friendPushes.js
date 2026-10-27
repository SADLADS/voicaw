const db = require('./db');
const { displayNameOf } = require('./profiles');
const { sendPushToUser, noteShown, clearNotifications, getUserImageUrl } = require('./push');

// Notifications about friends (friends.js, routes/friends.js): someone asked you to be friends
// (`kind: 'request'`, opening the Friends page's Pending tab), or accepted your request
// (`kind: 'accepted'`, opening their DM). One per person (`tag` `friend-<their id>`), each
// replacing the last; no sound (the type isn't one of push.js MESSAGE_PUSHES). Blocking either
// way already stops requests. Answering a request (accepting, declining, cancelling) takes its
// notification down on the asked person's devices (`clearFriendRequest`). `title` and `body`
// are for apps that don't word it themselves (the client's notificationFromPush does).

// One push per pair and kind this often at most: asking, cancelling and asking again doesn't
// buzz each time.
const REPEAT_MS = 5 * 60 * 1000;
const recent = new Map();

function tooSoon(key) {
  const now = Date.now();
  for (const [k, at] of recent) if (now - at >= REPEAT_MS) recent.delete(k);
  if (recent.has(key)) return true;
  recent.set(key, now);
  return false;
}

const BODIES = { request: 'Sent you a friend request', accepted: 'Accepted your friend request' };

// `fromId` did `kind` to `toId`.
async function notify(kind, fromId, toId) {
  if (tooSoon(`${kind}:${fromId}:${toId}`)) return;
  const user = await db.get('SELECT username FROM users WHERE id = ?', [fromId]);
  if (!user) return;
  const name = await displayNameOf(fromId, user.username);
  const tag = `friend-${fromId}`;
  const { delivered } = await sendPushToUser(toId, {
    type: 'friend',
    kind,
    name,
    title: name,
    body: BODIES[kind],
    url: kind === 'request' ? '/dm/friends' : `/dm/${fromId}`,
    tag,
    image: await getUserImageUrl(fromId),
    timestamp: Math.floor(Date.now() / 1000),
  });
  if (delivered) noteShown(toId, tag);
}

// The request from `fromId` to `toId` was answered: its notification goes from `toId`'s devices.
function clearFriendRequest(toId, fromId) {
  clearNotifications(toId, `friend-${fromId}`);
}

// Never fails what caused it: the request is saved whether or not anyone hears about it.
const quietly = (fn) => (...args) => fn(...args).catch((err) => console.error('Friend push failed:', err.message));

module.exports = {
  notifyFriendRequest: quietly((fromId, toId) => notify('request', fromId, toId)),
  notifyFriendAccepted: quietly((fromId, toId) => notify('accepted', fromId, toId)),
  clearFriendRequest,
};
