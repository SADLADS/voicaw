const express = require('express');
const db = require('../db');
const { maxPlaintextLength, maxMessageLength } = require('../config');
const { authenticateJWT } = require('../auth');
const { sendToUserSockets, getStatus, isViewingConversation } = require('../sockets');
const { buildDmPushPayload, sendPushToUser, getUserImageUrl } = require('../push');
const { isConversationMuted } = require('../conversationSettings');
const { setPinned } = require('../pins');
const { reactionIdsFor, pollReactionsFor } = require('../polls');
const { removePollRows } = require('../pollTimers');
const { CALL_LOG } = require('../callLog');
const { listedKeys, linkListed, releaseUploads } = require('../uploads');

// Direct messages. Contents are end-to-end encrypted: the server stores and relays
// ciphertext only (and checks its length against the encrypted size of the plaintext limit).
const router = express.Router();

// A DM row with its sender's name and the message it replies to (still encrypted).
const DM_SELECT = `
  SELECT
    dm.id, dm.sender_id, dm.recipient_id, dm.content, dm.timestamp, dm.parent_message_id, dm.edited,
    dm.pinned_at, dm.pinned_by, dm.system,
    u.username AS sender_username,
    u.display_name AS sender_display_name,
    pm.content AS parent_content,
    pm.timestamp AS parent_timestamp,
    pu.id AS parent_sender_id,
    pu.username AS parent_username
  FROM direct_messages dm
  JOIN users u ON dm.sender_id = u.id
  LEFT JOIN direct_messages pm ON dm.parent_message_id = pm.id
  LEFT JOIN users pu ON pm.sender_id = pu.id`;

const IN_CONVERSATION = `((dm.sender_id = ? AND dm.recipient_id = ?) OR (dm.sender_id = ? AND dm.recipient_id = ?))`;

// Adds `reactions` ([{ id, user_id, content, timestamp }], oldest first) to each DM row (and to
// a "poll ended" row, its poll's as `poll_reactions`).
async function withReactions(messages) {
  if (messages.length === 0) return messages;
  const ids = reactionIdsFor(messages);
  const rows = await db.all(
    `SELECT id, message_id, user_id, content, timestamp FROM dm_reactions
     WHERE message_id IN (${ids.map(() => '?').join(',')}) ORDER BY id`,
    ids
  );
  const byMessage = new Map(ids.map((id) => [id, []]));
  for (const { message_id: messageId, ...reaction } of rows) byMessage.get(messageId).push(reaction);
  return messages.map((m) => ({ ...m, reactions: byMessage.get(m.id), ...pollReactionsFor(m, byMessage) }));
}

// Sends `event` to both people in a message's conversation (once, for notes to yourself).
function sendToConversation(message, event) {
  sendToUserSockets(message.sender_id, event);
  if (message.recipient_id !== message.sender_id) sendToUserSockets(message.recipient_id, event);
}

// Everyone else (not your notes, a DM to yourself), most recent conversation first, with their
// public keys, status and last seen. Deleted accounts only when you had a conversation with
// them (`deleted_at` set: it can be read, not answered). Never bots (bots.js): they're only in
// guilds.
router.get('/dms-list', authenticateJWT, async (req, res) => {
  const me = req.user.id;
  const users = await db.all(
    `SELECT u.id, u.username, u.display_name, u.custom_status, u.bio, u.avatar,
            u.identity_key, u.encryption_key, u.encryption_key_signature, u.last_online, u.deleted_at,
            MAX(m.timestamp) AS last_timestamp
     FROM users u
     LEFT JOIN direct_messages m
       ON ((m.sender_id = ? AND m.recipient_id = u.id) OR (m.recipient_id = ? AND m.sender_id = u.id))
     WHERE u.id != ? AND u.bot = 0
     GROUP BY u.id
     HAVING u.deleted_at IS NULL OR last_timestamp IS NOT NULL
     ORDER BY last_timestamp DESC NULLS LAST`,
    [me, me, me]
  );
  res.json(users.map((user) => ({ ...user, status: getStatus(user.id) })));
});

// A page of a conversation, oldest first: the newest `limit` messages (1–100, default 10),
// or those before message id `before`.
router.get('/dm-messages/:otherUserId', authenticateJWT, async (req, res) => {
  const me = req.user.id;
  const other = parseInt(req.params.otherUserId, 10);
  if (Number.isNaN(other)) return res.status(400).json({ error: 'Invalid user ID' });
  const requestedLimit = parseInt(req.query.limit, 10);
  const limit = Number.isNaN(requestedLimit) ? 10 : Math.min(Math.max(requestedLimit, 1), 100);
  const before = parseInt(req.query.before, 10);

  const params = [me, other, other, me];
  let where = IN_CONVERSATION;
  if (!Number.isNaN(before)) {
    where += ' AND dm.id < ?';
    params.push(before);
  }
  const rows = await db.all(`${DM_SELECT} WHERE ${where} ORDER BY dm.id DESC LIMIT ?`, [...params, limit]);
  res.json(await withReactions(rows.reverse()));
});

router.post('/dm-send', authenticateJWT, async (req, res) => {
  const senderId = req.user.id;
  const { recipient_id: rawRecipientId, content, replyTo } = req.body;
  // The uploads the message shows (the server can't read it): see uploads.js.
  const uploads = listedKeys(req.body?.uploads);
  if (uploads === null) return res.status(400).json({ error: 'Invalid uploads' });

  if (content != null && typeof content !== 'string') {
    return res.status(400).json({ error: 'Invalid content' });
  }
  if (!rawRecipientId || !content || !content.trim()) {
    return res.status(400).json({ error: 'Missing recipient or content' });
  }
  if (content.length > maxMessageLength) {
    return res.status(400).json({ error: `Message too long. Max allowed characters: ${maxPlaintextLength} bytes` });
  }

  const recipientId = Number(rawRecipientId);
  if (!Number.isInteger(recipientId)) {
    return res.status(400).json({ error: 'Invalid recipient' });
  }
  if (!(await db.get('SELECT id FROM users WHERE id = ? AND deleted_at IS NULL AND bot = 0', [recipientId]))) {
    return res.status(404).json({ error: 'Recipient not found' });
  }

  // A reply must point at a message in this same conversation.
  let parentMessageId = null;
  if (replyTo != null) {
    parentMessageId = Number(replyTo);
    const parent = Number.isInteger(parentMessageId) && await db.get(
      `SELECT id FROM direct_messages dm WHERE id = ? AND ${IN_CONVERSATION} AND system IS NOT '${CALL_LOG}'`,
      [parentMessageId, senderId, recipientId, recipientId, senderId]
    );
    if (!parent) return res.status(400).json({ error: 'Invalid reply' });
  }

  // A DM to yourself is your notes: never unread, never pushed.
  const notes = recipientId === senderId;
  const lastID = await db.transaction(async () => {
    const { lastID: id } = await db.run(
      `INSERT INTO direct_messages (sender_id, recipient_id, content, parent_message_id, timestamp)
       VALUES (?, ?, ?, ?, strftime('%s','now'))`,
      [senderId, recipientId, content.trim(), parentMessageId]
    );
    await linkListed('dm', id, uploads, senderId);
    if (!notes) await db.run(
      `INSERT INTO dm_unread (user_id, from_user_id, count) VALUES (?, ?, 1)
       ON CONFLICT(user_id, from_user_id) DO UPDATE SET count = count + 1`,
      [recipientId, senderId]
    );
    return id;
  });
  const message = await db.get(`${DM_SELECT} WHERE dm.id = ?`, [lastID]);

  sendToConversation(message, { type: 'new_dm', message });

  // Don't buzz someone about a conversation they're looking at right now, or have muted.
  if (!notes && !isViewingConversation(recipientId, senderId) && !(await isConversationMuted(recipientId, 'dm', senderId))) {
    Promise.all([
      getUserImageUrl(senderId),
      db.get('SELECT username FROM users WHERE id = ?', [recipientId]),
    ]).then(([imageUrl, recipient]) =>
      sendPushToUser(recipientId, buildDmPushPayload(message, imageUrl, recipient?.username), {
        urgency: 'high',
        topic: `dm${senderId}`,
      })
    ).catch((err) => console.error('DM push failed:', err.message));
  }

  res.status(201).json(message);
});

router.post('/dm-mark-read/:fromUserId', authenticateJWT, async (req, res) => {
  const fromUserId = parseInt(req.params.fromUserId, 10);
  if (Number.isNaN(fromUserId)) return res.status(400).json({ error: 'Invalid fromUserId' });
  await db.run('DELETE FROM dm_unread WHERE user_id = ? AND from_user_id = ?', [req.user.id, fromUserId]);
  res.json({ success: true });
});

router.get('/dm-get-unread', authenticateJWT, async (req, res) => {
  res.json(await db.all('SELECT * FROM dm_unread WHERE user_id = ?', [req.user.id]));
});

// Only the sender can delete a message; its reactions go with it.
router.delete('/messages/:id', authenticateJWT, async (req, res) => {
  const messageId = parseInt(req.params.id, 10);
  if (!messageId) return res.status(400).json({ error: 'Invalid message ID' });

  const row = await db.get('SELECT * FROM direct_messages WHERE id = ?', [messageId]);
  if (!row) return res.status(404).json({ error: 'Message not found' });
  if (row.sender_id !== req.user.id) return res.status(403).json({ error: 'Not authorized to delete this message' });
  if (row.system === CALL_LOG) return res.status(403).json({ error: "A call in the chat can't be changed" });

  // A poll takes its "poll ended" row with it.
  const removed = await db.transaction(async () => {
    await db.run('DELETE FROM dm_reactions WHERE message_id = ?', [messageId]);
    await db.run('DELETE FROM direct_messages WHERE id = ?', [messageId]);
    return removePollRows('dm', messageId);
  });
  releaseUploads();

  for (const id of [messageId, ...removed]) sendToConversation(row, { type: 'delete_dm', messageId: id, sender_id: row.sender_id });
  res.json({ success: true, deletedId: messageId });
});

// Only the sender can edit a message (`content` is the new ciphertext, `uploads` what it
// shows now).
router.put('/update-message/:id', authenticateJWT, async (req, res) => {
  const messageId = parseInt(req.params.id, 10);
  const { content } = req.body;
  const uploads = listedKeys(req.body?.uploads);
  if (!messageId || !content || typeof content !== 'string' || uploads === null) {
    return res.status(400).json({ error: 'Invalid input' });
  }
  if (content.length > maxMessageLength) {
    return res.status(400).json({ error: `Message too long. Max length is ${maxPlaintextLength} characters.` });
  }

  const row = await db.get('SELECT * FROM direct_messages WHERE id = ?', [messageId]);
  if (!row) return res.status(404).json({ error: 'Message not found' });
  if (row.sender_id !== req.user.id) return res.status(403).json({ error: 'Not authorized' });
  if (row.system) return res.status(403).json({ error: "This message can't be edited" });

  await db.transaction(async () => {
    await db.run('UPDATE direct_messages SET content = ?, edited = 1 WHERE id = ?', [content, messageId]);
    await linkListed('dm', messageId, uploads, req.user.id, { edit: true });
  });
  releaseUploads();

  sendToConversation(row, { type: 'edit_dm', messageId, content });
  res.json({ success: true, messageId, content });
});

// ---- Pins: either person can pin or unpin any message of the conversation ----

// The conversation's pinned messages, most recently pinned first.
router.get('/dm-pins/:otherUserId', authenticateJWT, async (req, res) => {
  const me = req.user.id;
  const other = parseInt(req.params.otherUserId, 10);
  if (Number.isNaN(other)) return res.status(400).json({ error: 'Invalid user ID' });
  const rows = await db.all(
    `${DM_SELECT} WHERE ${IN_CONVERSATION} AND dm.pinned_at IS NOT NULL ORDER BY dm.pinned_at DESC, dm.id DESC`,
    [me, other, other, me]
  );
  res.json(await withReactions(rows));
});

async function pinRoute(req, res, pinned) {
  const messageId = parseInt(req.params.id, 10);
  const row = Number.isInteger(messageId) && await db.get(
    'SELECT id, sender_id, recipient_id, system FROM direct_messages WHERE id = ?',
    [messageId]
  );
  if (!row || (row.sender_id !== req.user.id && row.recipient_id !== req.user.id)) {
    return res.status(404).json({ error: 'Message not found' });
  }
  if (row.system === CALL_LOG) return res.status(403).json({ error: "A call in the chat can't be changed" });
  const result = await setPinned(
    'direct_messages', messageId, req.user.id, pinned,
    '((sender_id = ? AND recipient_id = ?) OR (sender_id = ? AND recipient_id = ?))',
    [row.sender_id, row.recipient_id, row.recipient_id, row.sender_id]
  );
  if (result.error) return res.status(result.status).json({ error: result.error });
  const pin = { messageId, pinned_at: result.pinned_at, pinned_by: result.pinned_by };
  if (result.changed) {
    sendToConversation(row, { type: 'dm_pin', sender_id: row.sender_id, recipient_id: row.recipient_id, ...pin });
  }
  res.json(pin);
}

router.put('/dm-messages/:id/pin', authenticateJWT, (req, res) => pinRoute(req, res, true));
router.delete('/dm-messages/:id/pin', authenticateJWT, (req, res) => pinRoute(req, res, false));

// One DM row as the chat receives it (with its reactions).
async function loadMessage(id) {
  const row = await db.get(`${DM_SELECT} WHERE dm.id = ?`, [id]);
  return row ? (await withReactions([row]))[0] : null;
}

module.exports = router;
module.exports.loadMessage = loadMessage;
module.exports.sendToConversation = sendToConversation;
