const express = require('express');
const db = require('../db');
const { CALL_LOG } = require('../callLog');
const { maxPlaintextLength, getMaxEncryptedLength } = require('../config');
const { authenticateJWT } = require('../auth');
const { sendToUserSockets, getStatus, isViewingConversation } = require('../sockets');
const { sendPushToUser, buildGroupPushPayload } = require('../push');
const { isConversationMuted } = require('../conversationSettings');
const groups = require('../groupDms');
const calls = require('../calls');
const { displayNameOf } = require('../profiles');
const { setPinned } = require('../pins');
const { reactionIdsFor, pollReactionsFor } = require('../polls');
const { removePollRows } = require('../pollTimers');
const { listedKeys, linkListed, releaseUploads } = require('../uploads');

// Group DMs (see groupDms.js): creating one, its membership log (add, remove, leave), key
// epochs, and its messages and reactions (all ciphertext). Everything 404s for non-members.
const router = express.Router();

// Poll votes and added answers count too (see DM reactions).
const MAX_REACTIONS_PER_USER_PER_MESSAGE = 50;
// Messages, edits and reactions are signed inside their encryption (client groupCrypto.js):
// "v2." envelopes, whose plaintext starts with a 64-byte signature. (Older "v1." ones, from
// before signing, are still served; new ones must be signed.)
const SIGNED_PREFIX = 'v2.';
const SIGNATURE_BYTES = 64;
const MAX_MESSAGE_LENGTH = getMaxEncryptedLength(maxPlaintextLength + SIGNATURE_BYTES);
// A signed reaction is always one of these long: signature + 256 padded bytes (64 from apps
// from before answers could be added to polls; see DM reactions).
const REACTION_LENGTHS = [256, 64].map((padded) => getMaxEncryptedLength(SIGNATURE_BYTES + padded));
const OUTDATED = 'Please update the app (group messages are signed now)';

// A new message or edit's content: signed, and not too long. -> an error message, or null.
function contentError(content) {
  if (typeof content !== 'string' || !content.trim()) return 'Missing content';
  if (!content.startsWith(SIGNED_PREFIX)) return OUTDATED;
  if (content.length > MAX_MESSAGE_LENGTH) return `Message too long. Max allowed characters: ${maxPlaintextLength}`;
  return null;
}

// A message row, as `viewerId` may see it: only messages of epochs they have a key for, and
// a reply's parent only if they can read that too.
const MESSAGE_SELECT = `
  SELECT m.id, m.group_id, m.epoch, m.sender_id, m.content, m.timestamp, m.parent_message_id, m.edited,
    m.pinned_at, m.pinned_by, m.system,
    u.username AS sender_username,
    u.display_name AS sender_display_name,
    CASE WHEN pk.user_id IS NOT NULL THEN pm.content END AS parent_content,
    CASE WHEN pk.user_id IS NOT NULL THEN pm.epoch END AS parent_epoch,
    CASE WHEN pk.user_id IS NOT NULL THEN pm.timestamp END AS parent_timestamp,
    CASE WHEN pk.user_id IS NOT NULL THEN pm.parent_message_id END AS parent_reply_to,
    CASE WHEN pk.user_id IS NOT NULL THEN pm.edited END AS parent_edited,
    CASE WHEN pk.user_id IS NOT NULL THEN pm.sender_id END AS parent_sender_id,
    CASE WHEN pk.user_id IS NOT NULL THEN pu.username END AS parent_username
  FROM group_dm_messages m
  JOIN users u ON u.id = m.sender_id
  JOIN group_dm_epoch_keys k ON k.group_id = m.group_id AND k.epoch = m.epoch AND k.user_id = ?
  LEFT JOIN group_dm_messages pm ON pm.id = m.parent_message_id
  LEFT JOIN group_dm_epoch_keys pk ON pk.group_id = pm.group_id AND pk.epoch = pm.epoch AND pk.user_id = ?
  LEFT JOIN users pu ON pu.id = pm.sender_id`;

async function withReactions(messages) {
  if (messages.length === 0) return messages;
  const ids = reactionIdsFor(messages);
  const rows = await db.all(
    `SELECT id, message_id, user_id, content, timestamp FROM group_dm_reactions
     WHERE message_id IN (${ids.map(() => '?').join(',')}) ORDER BY id`,
    ids
  );
  const byMessage = new Map(ids.map((id) => [id, []]));
  for (const { message_id: messageId, ...reaction } of rows) byMessage.get(messageId).push(reaction);
  return messages.map((m) => ({ ...m, reactions: byMessage.get(m.id), ...pollReactionsFor(m, byMessage) }));
}

async function messageFor(viewerId, messageId) {
  const row = await db.get(`${MESSAGE_SELECT} WHERE m.id = ?`, [viewerId, viewerId, messageId]);
  return row ? (await withReactions([row]))[0] : null;
}

// Sends a GroupError as its status; anything else goes to the error handler.
function handle(fn) {
  return async (req, res) => {
    try {
      await fn(req, res);
    } catch (err) {
      if (err instanceof groups.GroupError) return res.status(err.status).json({ error: err.message });
      throw err;
    }
  };
}

async function requireMember(req, res, next) {
  const state = await groups.memberState(req.params.groupId, req.user.id);
  if (!state) return res.status(404).json({ error: 'Group not found' });
  req.state = state;
  next();
}
const member = [authenticateJWT, requireMember];

// Your groups, most recent first.
router.get('/group-dms', authenticateJWT, async (req, res) => {
  const rows = await db.all('SELECT group_id FROM group_dm_members WHERE user_id = ?', [req.user.id]);
  const list = [];
  for (const { group_id: groupId } of rows) list.push(await groups.groupSummary(groupId, req.user.id));
  list.sort((a, b) => b.last_timestamp - a.last_timestamp);
  res.json(list);
});

// A new group: { id (UUID), log: [create, add…] (signed), epoch: { epoch: 1, logSeq,
// envelopes, name (encrypted, version 1), nameVersion: 1 } }. Everyone in it gets `group_dm_add`.
router.post('/group-dms', authenticateJWT, handle(async (req, res) => {
  const { id, log, epoch } = req.body ?? {};
  if (typeof id !== 'string' || !groups.UUID.test(id)) return res.status(400).json({ error: 'Invalid group id' });
  if (await db.get('SELECT id FROM group_dms WHERE id = ?', [id])) return res.status(409).json({ error: 'Group already exists' });
  if (!groups.isNameCiphertext(epoch?.name) || epoch.nameVersion !== 1) return res.status(400).json({ error: groups.NAME_OUTDATED });
  if (!Array.isArray(log) || log.length < 3) return res.status(400).json({ error: 'A group needs at least two other people' });
  if (log.length > groups.MAX_MEMBERS) return res.status(400).json({ error: `Groups have at most ${groups.MAX_MEMBERS} people` });

  // Check the whole log before storing anything: the creator makes it and adds everyone.
  const state = { group: { id }, members: new Set(), ownerId: null, nextSeq: 0, prevHash: null, latestEpoch: null };
  const records = [];
  for (const [i, entry] of log.entries()) {
    const r = await groups.checkEntry(state, entry, req.user.id);
    if ((i === 0) !== (r.type === 'create') || (i > 0 && r.type !== 'add')) {
      return res.status(400).json({ error: 'Invalid membership change' });
    }
    groups.applyToState(state, entry, r);
    records.push(r);
  }
  // Checked against the members about to exist.
  const epochState = { ...state, group: { id, name_version: 1 } };
  await db.transaction(async () => {
    await db.run('INSERT INTO group_dms (id, owner_id, created_at, name_version) VALUES (?, ?, ?, 1)', [id, req.user.id, Math.floor(Date.now() / 1000)]);
    for (const [i, r] of records.entries()) await groups.storeEntry(id, log[i], r);
    await groups.storeEpoch(epochState, req.user.id, epoch ?? {});
  });
  for (const userId of state.members) {
    sendToUserSockets(userId, { type: 'group_dm_add', group: await groups.groupSummary(id, userId) });
  }
  res.status(201).json(await groups.groupSummary(id, req.user.id));
}));

// Everything a member needs to check the group and read it: the summary, the whole
// membership log, the public keys of everyone in it, and the member's own epoch keys.
router.get('/group-dms/:groupId', member, async (req, res) => {
  const groupId = req.state.group.id;
  const log = await db.all('SELECT seq, record, signature FROM group_dm_log WHERE group_id = ? ORDER BY seq', [groupId]);
  const users = await db.all(
    `SELECT id, username, display_name, custom_status, bio, avatar, last_online, identity_key, encryption_key, encryption_key_signature FROM users
     WHERE id IN (SELECT actor_id FROM group_dm_log WHERE group_id = ? UNION SELECT target_id FROM group_dm_log WHERE group_id = ?)`,
    [groupId, groupId]
  );
  const epochs = await db.all(
    `SELECT e.epoch, e.log_seq, e.creator_id, k.envelope FROM group_dm_epochs e
     JOIN group_dm_epoch_keys k ON k.group_id = e.group_id AND k.epoch = e.epoch AND k.user_id = ?
     WHERE e.group_id = ? ORDER BY e.epoch`,
    [req.user.id, groupId]
  );
  res.json({
    ...(await groups.groupSummary(groupId, req.user.id)),
    log,
    users: users.map((u) => ({ ...u, status: getStatus(u.id) })),
    epochs,
    latest_epoch: req.state.latestEpoch ?? null,
    // A call going on in the group (to join), or null.
    call: calls.groupCall(groupId) ? calls.publicCall(calls.groupCall(groupId)) : null,
  });
});

// Rename (any member): { name (encrypted with the latest epoch, signed by the renamer inside),
// epoch, version (the current one + 1), initial? (encrypting a name from before names were
// encrypted: no rename row) }. 409 if the group changed meanwhile.
router.patch('/group-dms/:groupId', member, handle(async (req, res) => {
  const { state } = req;
  const groupId = state.group.id;
  const rowId = await groups.storeName(state, req.user.id, req.body ?? {});
  for (const userId of state.members) {
    sendToUserSockets(userId, { type: 'group_dm_update', group: await groups.groupSummary(groupId, userId) });
    if (rowId) sendToUserSockets(userId, { type: 'group_dm_message_new', groupId, message: await messageFor(userId, rowId) });
  }
  res.json(await groups.groupSummary(groupId, req.user.id));
}));

// A membership change: { entry: { record, signature } } (add, remove, leave), with the next
// `epoch` for the new membership: always for an add (so whoever's added can read the group's
// name; if it loses a race the add fails too), optionally for a remove; after a leave the next
// member to send one makes it. The people affected get `group_dm_add` /
// `group_dm_remove`, everyone else `group_dm_update` with the entry.
router.post('/group-dms/:groupId/log', member, handle(async (req, res) => {
  const { state } = req;
  const groupId = state.group.id;
  const { entry, epoch } = req.body ?? {};
  const before = new Set(state.members);
  const r = await groups.checkEntry(state, entry, req.user.id);
  if (r.type === 'add' && !epoch) return res.status(400).json({ error: 'Adding someone needs the new key' });
  groups.applyToState(state, entry, r);
  await db.transaction(async () => {
    await groups.storeEntry(groupId, entry, r);
    if (epoch) {
      try {
        await groups.storeEpoch(state, req.user.id, epoch);
      } catch (err) {
        // A remove stands; the next message makes the epoch.
        if (!(err instanceof groups.GroupError) || r.type === 'add') throw err;
      }
    }
    if (state.members.size === 0) await groups.deleteGroup(groupId);
  });
  if (state.members.size === 0) releaseUploads();

  if (state.members.size > 0) {
    await calls.leaveGroupCall(groupId, r.type === 'add' ? null : r.target);
  }
  const stored = { seq: r.seq, record: entry.record, signature: entry.signature };
  await groups.announceEntry(state, before, stored);
  if (state.latestEpoch && epoch && state.latestEpoch.epoch === epoch.epoch) {
    await announceEpoch(groupId, state.latestEpoch);
  }
  res.json({ success: true, entry: stored });
}));

// Each member gets their own key of the new epoch.
async function announceEpoch(groupId, epoch) {
  const keys = await db.all('SELECT user_id, envelope FROM group_dm_epoch_keys WHERE group_id = ? AND epoch = ?', [groupId, epoch.epoch]);
  for (const { user_id: userId, envelope } of keys) {
    sendToUserSockets(userId, { type: 'group_dm_epoch', groupId, epoch: { ...epoch, envelope } });
  }
}

// A new epoch for the current membership: { epoch, logSeq, envelopes: { userId: envelope } }.
// 409 if another member made it first (then use theirs).
router.post('/group-dms/:groupId/epochs', member, handle(async (req, res) => {
  const { state } = req;
  await groups.storeEpoch(state, req.user.id, req.body ?? {});
  await announceEpoch(state.group.id, state.latestEpoch);
  res.status(201).json(state.latestEpoch);
}));

// A page of messages you can read, oldest first (like DMs: `limit` 1–100, `before` an id).
router.get('/group-dms/:groupId/messages', member, async (req, res) => {
  const requested = parseInt(req.query.limit, 10);
  const limit = Number.isNaN(requested) ? 50 : Math.min(Math.max(requested, 1), 100);
  const before = parseInt(req.query.before, 10);
  const params = [req.user.id, req.user.id, req.state.group.id];
  let where = 'm.group_id = ?';
  if (!Number.isNaN(before)) {
    where += ' AND m.id < ?';
    params.push(before);
  }
  const rows = await db.all(`${MESSAGE_SELECT} WHERE ${where} ORDER BY m.id DESC LIMIT ?`, [...params, limit]);
  res.json(await withReactions(rows.reverse()));
});

// Send: { epoch, content, replyTo, uploads }. The epoch must be the newest, for the current
// members: otherwise 409 `{ code: 'stale_epoch' }` (make the next one first). `uploads`: the
// files it shows (uploads.js).
router.post('/group-dms/:groupId/messages', member, async (req, res) => {
  const { state } = req;
  const groupId = state.group.id;
  const { epoch, content, replyTo } = req.body ?? {};
  const invalid = contentError(content);
  if (invalid) return res.status(400).json({ error: invalid });
  const uploads = listedKeys(req.body?.uploads);
  if (uploads === null) return res.status(400).json({ error: 'Invalid uploads' });
  const latest = state.latestEpoch;
  if (!latest || epoch !== latest.epoch || latest.log_seq !== state.nextSeq - 1) {
    return res.status(409).json({ error: 'The group changed; its key has to be renewed', code: 'stale_epoch' });
  }
  let parentId = null;
  if (replyTo != null) {
    const parent = await messageFor(req.user.id, Number(replyTo));
    if (!parent || parent.group_id !== groupId || parent.system === CALL_LOG || parent.system === groups.NAME_ROW) return res.status(400).json({ error: 'Invalid reply' });
    parentId = parent.id;
  }
  const lastID = await db.transaction(async () => {
    const { lastID: id } = await db.run(
      `INSERT INTO group_dm_messages (group_id, epoch, sender_id, content, parent_message_id, timestamp)
       VALUES (?, ?, ?, ?, ?, strftime('%s','now'))`,
      [groupId, epoch, req.user.id, content.trim(), parentId]
    );
    await linkListed('group', id, uploads, req.user.id);
    await db.run(
      `INSERT INTO group_dm_reads (user_id, group_id, last_read_id) VALUES (?, ?, ?)
       ON CONFLICT(user_id, group_id) DO UPDATE SET last_read_id = excluded.last_read_id`,
      [req.user.id, groupId, id]
    );
    return id;
  });

  const senderName = await displayNameOf(req.user.id, req.user.username);
  // Those who blocked the sender still get the message (collapsed in their app), not a push.
  const blockers = await require('../blocks').blockersAmong(req.user.id, [...state.members]);
  for (const userId of state.members) {
    const message = await messageFor(userId, lastID);
    sendToUserSockets(userId, { type: 'group_dm_message_new', groupId, message });
    if (userId !== req.user.id && !blockers.has(userId) && !isViewingConversation(userId, `group-${groupId}`) && !(await isConversationMuted(userId, 'group', groupId))) {
      sendPushToUser(userId, await buildGroupPushPayload(groupId, message, userId, senderName), {
        urgency: 'high', topic: `group${groupId.replace(/-/g, '').slice(0, 20)}`,
      }).catch(() => {});
    }
  }
  res.status(201).json(await messageFor(req.user.id, lastID));
});

// The message, if it's in a group the caller is in and they can read it.
async function findMessage(req, res, next) {
  const message = await messageFor(req.user.id, Number(req.params.messageId));
  const state = message && await groups.memberState(message.group_id, req.user.id);
  if (!state) return res.status(404).json({ error: 'Message not found' });
  req.message = message;
  req.state = state;
  next();
}

// Calls in the chat (callLog.js) and renames can't be deleted, reacted to or pinned.
function notCallRow(req, res, next) {
  if (req.message.system === CALL_LOG) return res.status(403).json({ error: "A call in the chat can't be changed" });
  if (req.message.system === groups.NAME_ROW) return res.status(403).json({ error: "A rename can't be changed" });
  next();
}

// Edit your own message: { content, uploads } (encrypted with the message's epoch key).
router.put('/group-dm-messages/:messageId', authenticateJWT, findMessage, async (req, res) => {
  const { content } = req.body ?? {};
  const invalid = contentError(content);
  if (invalid) return res.status(400).json({ error: invalid });
  const uploads = listedKeys(req.body?.uploads);
  if (uploads === null) return res.status(400).json({ error: 'Invalid uploads' });
  if (req.message.sender_id !== req.user.id) return res.status(403).json({ error: 'Not your message' });
  if (req.message.system) return res.status(403).json({ error: "This message can't be edited" });
  await db.transaction(async () => {
    await db.run('UPDATE group_dm_messages SET content = ?, edited = 1 WHERE id = ?', [content.trim(), req.message.id]);
    await linkListed('group', req.message.id, uploads, req.user.id, { edit: true });
  });
  releaseUploads();
  await groups.sendToGroup(req.message.group_id, { type: 'group_dm_message_edit', groupId: req.message.group_id, messageId: req.message.id, content: content.trim() });
  res.json({ success: true });
});

// Delete your own message (and its reactions).
router.delete('/group-dm-messages/:messageId', authenticateJWT, findMessage, notCallRow, async (req, res) => {
  if (req.message.sender_id !== req.user.id) return res.status(403).json({ error: 'Not your message' });
  // A poll takes its "poll ended" row with it.
  const removed = await db.transaction(async () => {
    await db.run('DELETE FROM group_dm_reactions WHERE message_id = ?', [req.message.id]);
    await db.run('DELETE FROM group_dm_messages WHERE id = ?', [req.message.id]);
    return removePollRows('group', req.message.id);
  });
  releaseUploads();
  for (const id of [req.message.id, ...removed]) {
    await groups.sendToGroup(req.message.group_id, { type: 'group_dm_message_delete', groupId: req.message.group_id, messageId: id });
  }
  res.json({ success: true });
});

// React: { content } (the encrypted, padded emoji; see DM reactions).
router.post('/group-dm-messages/:messageId/reactions', authenticateJWT, findMessage, notCallRow, async (req, res) => {
  const { content } = req.body ?? {};
  if (typeof content === 'string' && content.startsWith('v1.')) return res.status(400).json({ error: OUTDATED });
  if (typeof content !== 'string' || !REACTION_LENGTHS.includes(content.length) || !content.startsWith(SIGNED_PREFIX)) {
    return res.status(400).json({ error: 'Invalid reaction' });
  }
  const { n } = await db.get('SELECT COUNT(*) AS n FROM group_dm_reactions WHERE message_id = ? AND user_id = ?', [req.message.id, req.user.id]);
  if (n >= MAX_REACTIONS_PER_USER_PER_MESSAGE) return res.status(400).json({ error: 'Too many reactions' });
  const { lastID } = await db.run(
    `INSERT INTO group_dm_reactions (message_id, user_id, content, timestamp) VALUES (?, ?, ?, strftime('%s','now'))`,
    [req.message.id, req.user.id, content]
  );
  const reaction = await db.get('SELECT id, message_id, user_id, content, timestamp FROM group_dm_reactions WHERE id = ?', [lastID]);
  await groups.sendToGroup(req.message.group_id, { type: 'group_dm_reaction_add', groupId: req.message.group_id, reaction });
  res.status(201).json(reaction);
});

// ---- Pins: any member can pin or unpin a message they can read ----

// The pinned messages you can read, most recently pinned first.
router.get('/group-dms/:groupId/pins', member, async (req, res) => {
  const rows = await db.all(
    `${MESSAGE_SELECT} WHERE m.group_id = ? AND m.pinned_at IS NOT NULL ORDER BY m.pinned_at DESC, m.id DESC`,
    [req.user.id, req.user.id, req.state.group.id]
  );
  res.json(await withReactions(rows));
});

async function pinRoute(req, res, pinned) {
  const groupId = req.message.group_id;
  const result = await setPinned('group_dm_messages', req.message.id, req.user.id, pinned, 'group_id = ?', [groupId]);
  if (result.error) return res.status(result.status).json({ error: result.error });
  const pin = { messageId: req.message.id, pinned_at: result.pinned_at, pinned_by: result.pinned_by };
  if (result.changed) await groups.sendToGroup(groupId, { type: 'group_dm_message_pin', groupId, ...pin });
  res.json(pin);
}

router.put('/group-dm-messages/:messageId/pin', authenticateJWT, findMessage, notCallRow, (req, res) => pinRoute(req, res, true));
router.delete('/group-dm-messages/:messageId/pin', authenticateJWT, findMessage, notCallRow, (req, res) => pinRoute(req, res, false));

router.delete('/group-dm-reactions/:reactionId', authenticateJWT, async (req, res) => {
  const reaction = await db.get('SELECT id, message_id, user_id FROM group_dm_reactions WHERE id = ?', [Number(req.params.reactionId)]);
  if (!reaction || reaction.user_id !== req.user.id) return res.status(404).json({ error: 'Reaction not found' });
  const message = await db.get('SELECT group_id FROM group_dm_messages WHERE id = ?', [reaction.message_id]);
  await db.run('DELETE FROM group_dm_reactions WHERE id = ?', [reaction.id]);
  await groups.sendToGroup(message.group_id, { type: 'group_dm_reaction_remove', groupId: message.group_id, messageId: reaction.message_id, reactionId: reaction.id });
  res.json({ success: true });
});

// Read up to `messageId`, or with `latest: true` up to the newest message (Mark As Read).
router.post('/group-dms/:groupId/read', member, async (req, res) => {
  const messageId = req.body?.latest === true
    ? (await db.get('SELECT MAX(id) AS id FROM group_dm_messages WHERE group_id = ?', [req.state.group.id])).id ?? 0
    : Number(req.body?.messageId);
  if (!Number.isInteger(messageId) || messageId < 0) return res.status(400).json({ error: 'Invalid message' });
  await db.run(
    `INSERT INTO group_dm_reads (user_id, group_id, last_read_id) VALUES (?, ?, ?)
     ON CONFLICT(user_id, group_id) DO UPDATE SET last_read_id = MAX(last_read_id, excluded.last_read_id)`,
    [req.user.id, req.state.group.id, messageId]
  );
  res.json({ success: true });
});

module.exports = router;
module.exports.messageFor = messageFor;
