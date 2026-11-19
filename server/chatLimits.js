const db = require('./db');
const { createLimiter, createDistinctLimiter, overLimit } = require('./rateLimit');
const { areFriends } = require('./friends');

// Per-account limits on DMs, group DMs and calls (security audit, low findings L3): sign-ups are
// open, so one account mustn't be able to flood anyone or everyone. Generous for people, who
// never come near them; the 429 is the app's usual "too many, try later". Stricter towards a
// stranger: someone who isn't a friend and has never written to the sender.
const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;

const LIMITS = {
  // Messages (DMs and group DMs), pins and reactions (poll votes and added answers are
  // reactions too), each per account.
  messages: createLimiter({ windowMs: MINUTE, max: 60 }),
  pins: createLimiter({ windowMs: MINUTE, max: 30 }),
  reactions: createLimiter({ windowMs: MINUTE, max: 120 }),
  // Towards one stranger, and how many strangers someone starts writing to.
  strangerMessages: createLimiter({ windowMs: MINUTE, max: 5 }),
  strangers: createDistinctLimiter({ windowMs: HOUR, max: 20 }),
  // Groups: new ones, new keys (epochs) and renames or picture changes.
  groups: createLimiter({ windowMs: HOUR, max: 10 }),
  epochs: createLimiter({ windowMs: HOUR, max: 60 }),
  renames: createLimiter({ windowMs: HOUR, max: 30 }),
  // Ringing (1:1 and group calls), and the same stranger.
  rings: createLimiter({ windowMs: 10 * MINUTE, max: 10 }),
  strangerRings: createLimiter({ windowMs: 10 * MINUTE, max: 3 }),
};

// Counts one `kind` for `userId`: the ms to wait if over the limit, else 0.
const over = (kind, userId) => overLimit(LIMITS[kind], String(userId));

// Whether `otherId` is a stranger to `userId`: not friends, and has never sent them a DM.
async function isStranger(userId, otherId) {
  if (userId === otherId || await areFriends(userId, otherId)) return false;
  return !(await db.get('SELECT 1 FROM direct_messages WHERE sender_id = ? AND recipient_id = ? LIMIT 1', [otherId, userId]));
}

// A DM from `senderId` to `recipientId`: the ms to wait if over a limit, else 0.
async function overDmLimit(senderId, recipientId) {
  const wait = over('messages', senderId);
  if (wait || !(await isStranger(senderId, recipientId))) return wait;
  return overLimit(LIMITS.strangers, String(senderId), recipientId)
    || overLimit(LIMITS.strangerMessages, `${senderId}:${recipientId}`);
}

// `callerId` ringing `calleeId` (null for a group call): the ms to wait if over a limit, else 0.
async function overRingLimit(callerId, calleeId) {
  const wait = over('rings', callerId);
  if (wait || calleeId == null || !(await isStranger(callerId, calleeId))) return wait;
  return overLimit(LIMITS.strangerRings, `${callerId}:${calleeId}`);
}

module.exports = { LIMITS, over, isStranger, overDmLimit, overRingLimit };
