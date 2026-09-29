const crypto = require('crypto');
const db = require('./db');
const { sendToUserSockets } = require('./sockets');

// Group DMs: end-to-end encrypted like DMs, for up to MAX_MEMBERS people. The server keeps
// the membership and relays ciphertext; clients hold the keys (see CLAUDE.md, Group DMs).
//
// Membership changes are a log of records that their author signed with their identity key,
// in a hash chain. The server checks each record the same way clients do (who may do what,
// the signature, the chain), so a broken or forged change never gets stored. Clients check
// it again themselves: that's what keeps the server from adding anyone.
//
// Messages are encrypted with the key of an epoch (a key period). There's a new epoch after
// every membership change, for the members as of that change; each member gets the epoch key
// encrypted for them. Someone added later never gets older keys (and the server doesn't send
// them older messages); someone removed never gets newer ones. Someone re-added keeps the
// keys (and the messages) of the times they were a member.

const MAX_MEMBERS = 10;
const MAX_NAME = 100;
// An encrypted key: "v1." + base64 of IV, 44 bytes of base64 key, tag.
const MAX_ENVELOPE = 200;
const LOG_CONTEXT = 'voicaw/group-log/v1';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const now = () => Math.floor(Date.now() / 1000);

class GroupError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// The previous entry's hash, as the next record's `prev`.
function entryHash(record, signature) {
  return crypto.createHash('sha256').update(`${record}\n${signature}`).digest('base64');
}

async function verifySignature(identityKey, record, signature) {
  try {
    const key = await crypto.webcrypto.subtle.importKey(
      'raw', Buffer.from(identityKey, 'base64'), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']
    );
    return await crypto.webcrypto.subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' },
      key,
      Buffer.from(signature, 'base64'),
      new TextEncoder().encode(`${LOG_CONTEXT}\n${record}`)
    );
  } catch {
    return false;
  }
}

// The group as it is now: { group, members: Set of user ids, ownerId, nextSeq, prevHash,
// latestEpoch (row or undefined) }, or null.
async function groupState(groupId) {
  if (typeof groupId !== 'string' || !UUID.test(groupId)) return null;
  const group = await db.get('SELECT id, name, owner_id, created_at FROM group_dms WHERE id = ?', [groupId]);
  if (!group) return null;
  const members = new Set((await db.all('SELECT user_id FROM group_dm_members WHERE group_id = ?', [groupId])).map((r) => r.user_id));
  const last = await db.get('SELECT seq, record, signature FROM group_dm_log WHERE group_id = ? ORDER BY seq DESC LIMIT 1', [groupId]);
  const latestEpoch = await db.get('SELECT epoch, log_seq, creator_id FROM group_dm_epochs WHERE group_id = ? ORDER BY epoch DESC LIMIT 1', [groupId]);
  return {
    group,
    members,
    ownerId: group.owner_id,
    nextSeq: last ? last.seq + 1 : 0,
    prevHash: last ? entryHash(last.record, last.signature) : null,
    latestEpoch,
  };
}

// The group if `userId` is in it now, else null.
async function memberState(groupId, userId) {
  const state = await groupState(groupId);
  return state && state.members.has(userId) ? state : null;
}

// Checks `entry` ({ record, signature }) as the next log entry, made by `actorId`, against
// `state` (groupState's shape; for a new group, an empty one). Returns the parsed record, or
// throws a GroupError. Doesn't change anything.
async function checkEntry(state, entry, actorId) {
  const { record, signature } = entry ?? {};
  if (typeof record !== 'string' || typeof signature !== 'string' || record.length > 2000) {
    throw new GroupError(400, 'Invalid membership change');
  }
  let r;
  try {
    r = JSON.parse(record);
  } catch {
    throw new GroupError(400, 'Invalid membership change');
  }
  if (r.v !== 1 || r.group !== state.group.id || r.seq !== state.nextSeq || r.prev !== state.prevHash) {
    throw new GroupError(409, 'The group changed meanwhile; try again');
  }
  if (r.actor !== actorId || !Number.isInteger(r.at)) throw new GroupError(400, 'Invalid membership change');

  if (r.type === 'create') {
    if (r.seq !== 0 || r.target !== null) throw new GroupError(400, 'Invalid membership change');
  } else if (r.type === 'add') {
    if (!state.members.has(actorId)) throw new GroupError(403, 'Not a member');
    if (state.members.has(r.target)) throw new GroupError(400, 'Already a member');
    if (state.members.size >= MAX_MEMBERS) throw new GroupError(400, `Groups have at most ${MAX_MEMBERS} people`);
  } else if (r.type === 'remove') {
    if (state.ownerId !== actorId) throw new GroupError(403, 'Only the group owner can remove people');
    if (!state.members.has(r.target) || r.target === actorId) throw new GroupError(400, 'Not a member');
  } else if (r.type === 'leave') {
    if (r.target !== actorId || !state.members.has(actorId)) throw new GroupError(400, 'Not a member');
  } else {
    throw new GroupError(400, 'Invalid membership change');
  }

  // Who's named must be who the server knows, with their real identity key.
  const subject = r.type === 'create' ? actorId : r.target;
  const user = Number.isInteger(subject) && await db.get('SELECT id, identity_key FROM users WHERE id = ?', [subject]);
  if (!user) throw new GroupError(404, 'User not found');
  if ((r.type === 'create' || r.type === 'add') && r.targetIdentityKey !== user.identity_key) {
    throw new GroupError(400, 'Invalid membership change');
  }
  const actor = await db.get('SELECT identity_key FROM users WHERE id = ?', [actorId]);
  if (!(await verifySignature(actor.identity_key, record, signature))) {
    throw new GroupError(400, 'Invalid signature');
  }
  return r;
}

// Applies a checked record to `state` (in memory; for checking several in a row).
function applyToState(state, entry, r) {
  if (r.type === 'create' || r.type === 'add') state.members.add(r.type === 'create' ? r.actor : r.target);
  if (r.type === 'create') state.ownerId = r.actor;
  if (r.type === 'remove' || r.type === 'leave') {
    state.members.delete(r.target);
    if (state.ownerId === r.target) state.ownerId = null;
  }
  state.nextSeq = r.seq + 1;
  state.prevHash = entryHash(entry.record, entry.signature);
}

// Stores a checked record and applies it to the membership.
async function storeEntry(groupId, entry, r) {
  await db.run(
    `INSERT INTO group_dm_log (group_id, seq, record, signature, type, actor_id, target_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [groupId, r.seq, entry.record, entry.signature, r.type, r.actor, r.type === 'create' ? r.actor : r.target, now()]
  );
  if (r.type === 'create' || r.type === 'add') {
    const userId = r.type === 'create' ? r.actor : r.target;
    await db.run('INSERT OR IGNORE INTO group_dm_members (group_id, user_id, joined_at) VALUES (?, ?, ?)', [groupId, userId, now()]);
    // Unread starts now: a new member can't read anything older anyway.
    await db.run(
      `INSERT INTO group_dm_reads (user_id, group_id, last_read_id)
       VALUES (?, ?, COALESCE((SELECT MAX(id) FROM group_dm_messages WHERE group_id = ?), 0))
       ON CONFLICT(user_id, group_id) DO UPDATE SET last_read_id = excluded.last_read_id`,
      [userId, groupId, groupId]
    );
  } else {
    await db.run('DELETE FROM group_dm_members WHERE group_id = ? AND user_id = ?', [groupId, r.target]);
    await db.run('UPDATE group_dms SET owner_id = NULL WHERE id = ? AND owner_id = ?', [groupId, r.target]);
  }
}

// Checks and stores a new epoch: `epoch` must come next, be for the current membership
// (`logSeq` = the last log entry) and give every member exactly one envelope.
async function storeEpoch(state, creatorId, { epoch, logSeq, envelopes }) {
  const expected = (state.latestEpoch?.epoch ?? 0) + 1;
  if (epoch !== expected || logSeq !== state.nextSeq - 1) throw new GroupError(409, 'The group changed meanwhile; try again');
  if (!envelopes || typeof envelopes !== 'object') throw new GroupError(400, 'Invalid keys');
  const ids = Object.keys(envelopes).map(Number);
  if (ids.length !== state.members.size || !ids.every((id) => state.members.has(id))) {
    throw new GroupError(400, 'Keys must be for every member');
  }
  for (const envelope of Object.values(envelopes)) {
    if (typeof envelope !== 'string' || !envelope.startsWith('v1.') || envelope.length > MAX_ENVELOPE) {
      throw new GroupError(400, 'Invalid keys');
    }
  }
  try {
    await db.run(
      'INSERT INTO group_dm_epochs (group_id, epoch, log_seq, creator_id, created_at) VALUES (?, ?, ?, ?, ?)',
      [state.group.id, epoch, logSeq, creatorId, now()]
    );
  } catch (err) {
    // Another member made this epoch first.
    if (/UNIQUE|PRIMARY/.test(err.message)) throw new GroupError(409, 'The group changed meanwhile; try again');
    throw err;
  }
  for (const [userId, envelope] of Object.entries(envelopes)) {
    await db.run(
      'INSERT INTO group_dm_epoch_keys (group_id, epoch, user_id, envelope) VALUES (?, ?, ?, ?)',
      [state.group.id, epoch, Number(userId), envelope]
    );
  }
  state.latestEpoch = { epoch, log_seq: logSeq, creator_id: creatorId };
}

// The group for the list: id, name, owner, members (id, username), last message time, unread.
async function groupSummary(groupId, userId) {
  const group = await db.get('SELECT id, name, owner_id, created_at FROM group_dms WHERE id = ?', [groupId]);
  if (!group) return null;
  const members = await db.all(
    `SELECT u.id, u.username FROM group_dm_members gm JOIN users u ON u.id = gm.user_id
     WHERE gm.group_id = ? ORDER BY gm.joined_at, u.id`,
    [groupId]
  );
  const last = await db.get(
    `SELECT MAX(m.timestamp) AS t FROM group_dm_messages m
     JOIN group_dm_epoch_keys k ON k.group_id = m.group_id AND k.epoch = m.epoch AND k.user_id = ?
     WHERE m.group_id = ?`,
    [userId, groupId]
  );
  const unread = await db.get(
    `SELECT COUNT(*) AS n FROM group_dm_messages m
     JOIN group_dm_epoch_keys k ON k.group_id = m.group_id AND k.epoch = m.epoch AND k.user_id = ?
     WHERE m.group_id = ? AND m.sender_id != ?
       AND m.id > COALESCE((SELECT last_read_id FROM group_dm_reads WHERE user_id = ? AND group_id = ?), 0)`,
    [userId, groupId, userId, userId, groupId]
  );
  return { ...group, members, last_timestamp: last?.t ?? group.created_at, unread: unread.n };
}

async function memberIds(groupId) {
  return (await db.all('SELECT user_id FROM group_dm_members WHERE group_id = ?', [groupId])).map((r) => r.user_id);
}

async function sendToGroup(groupId, payload, exceptUserId = null) {
  for (const userId of await memberIds(groupId)) {
    if (userId !== exceptUserId) sendToUserSockets(userId, payload);
  }
}

// Everyone who's gone: the group and everything in it goes.
async function deleteGroup(groupId) {
  await db.run('DELETE FROM group_dm_reactions WHERE message_id IN (SELECT id FROM group_dm_messages WHERE group_id = ?)', [groupId]);
  for (const table of ['group_dm_messages', 'group_dm_epoch_keys', 'group_dm_epochs', 'group_dm_log', 'group_dm_reads', 'group_dm_members']) {
    await db.run(`DELETE FROM ${table} WHERE group_id = ?`, [groupId]);
  }
  await db.run('DELETE FROM group_dms WHERE id = ?', [groupId]);
}

module.exports = {
  MAX_MEMBERS,
  MAX_NAME,
  UUID,
  GroupError,
  entryHash,
  groupState,
  memberState,
  checkEntry,
  applyToState,
  storeEntry,
  storeEpoch,
  groupSummary,
  memberIds,
  sendToGroup,
  deleteGroup,
};
