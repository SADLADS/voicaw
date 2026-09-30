const express = require('express');
const db = require('../db');
const { maxPlaintextLength, maxMessageLength } = require('../config');
const { authenticateJWT } = require('../auth');
const { sendToUserSockets, getStatus, isViewingConversation } = require('../sockets');
const { buildDmPushPayload, sendPushToUser, getUserImageUrl } = require('../push');
const { setPinned } = require('../pins');

// Direct messages. Contents are end-to-end encrypted: the server stores and relays
// ciphertext only (and checks its length against the encrypted size of the plaintext limit).
const router = express.Router();

// A DM row with its sender's name and the message it replies to (still encrypted).
const DM_SELECT = `
  SELECT
    dm.id, dm.sender_id, dm.recipient_id, dm.content, dm.timestamp, dm.parent_message_id, dm.edited,
    dm.pinned_at, dm.pinned_by,
    u.username AS sender_username,
    u.display_name AS sender_display_name,
    pm.content AS parent_content,
    pu.id AS parent_sender_id,
    pu.username AS parent_username
  FROM direct_messages dm
  JOIN users u ON dm.sender_id = u.id
  LEFT JOIN direct_messages pm ON dm.parent_message_id = pm.id
  LEFT JOIN users pu ON pm.sender_id = pu.id`;

const IN_CONVERSATION = `((dm.sender_id = ? AND dm.recipient_id = ?) OR (dm.sender_id = ? AND dm.recipient_id = ?))`;

// Adds `reactions` ([{ id, user_id, content, timestamp }], oldest first) to each DM row.
async function withReactions(messages) {
  if (messages.length === 0) return messages;
  const ids = messages.map((m) => m.id);
  const rows = await db.all(
    `SELECT id, message_id, user_id, content, timestamp FROM dm_reactions
     WHERE message_id IN (${ids.map(() => '?').join(',')}) ORDER BY id`,
    ids
  );
  const byMessage = new Map(ids.map((id) => [id, []]));
  for (const { message_id: messageId, ...reaction } of rows) byMessage.get(messageId).push(reaction);
  return messages.map((m) => ({ ...m, reactions: byMessage.get(m.id) }));
}

// Everyone else, most recent conversation first, with their public keys, status and last seen.
router.get('/dms-list', authenticateJWT, async (req, res) => {
  const me = req.user.id;
  const users = await db.all(
    `SELECT u.id, u.username, u.display_name, u.custom_status, u.bio, u.avatar,
            u.identity_key, u.encryption_key, u.encryption_key_signature, u.last_online,
            MAX(m.timestamp) AS last_timestamp
     FROM users u
     LEFT JOIN direct_messages m
       ON ((m.sender_id = ? AND m.recipient_id = u.id) OR (m.recipient_id = ? AND m.sender_id = u.id))
     WHERE u.id != ?
     GROUP BY u.id
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
  if (!(await db.get('SELECT id FROM users WHERE id = ?', [recipientId]))) {
    return res.status(404).json({ error: 'Recipient not found' });
  }

  // A reply must point at a message in this same conversation.
  let parentMessageId = null;
  if (replyTo != null) {
    parentMessageId = Number(replyTo);
    const parent = Number.isInteger(parentMessageId) && await db.get(
      `SELECT id FROM direct_messages dm WHERE id = ? AND ${IN_CONVERSATION}`,
      [parentMessageId, senderId, recipientId, recipientId, senderId]
    );
    if (!parent) return res.status(400).json({ error: 'Invalid reply' });
  }

  const lastID = await db.transaction(async () => {
    const { lastID: id } = await db.run(
      `INSERT INTO direct_messages (sender_id, recipient_id, content, parent_message_id, timestamp)
       VALUES (?, ?, ?, ?, strftime('%s','now'))`,
      [senderId, recipientId, content.trim(), parentMessageId]
    );
    await db.run(
      `INSERT INTO dm_unread (user_id, from_user_id, count) VALUES (?, ?, 1)
       ON CONFLICT(user_id, from_user_id) DO UPDATE SET count = count + 1`,
      [recipientId, senderId]
    );
    return id;
  });
  const message = await db.get(`${DM_SELECT} WHERE dm.id = ?`, [lastID]);

  sendToUserSockets(recipientId, { type: 'new_dm', message });
  sendToUserSockets(senderId, { type: 'new_dm', message });

  // Don't buzz someone about a conversation they're looking at right now.
  if (!isViewingConversation(recipientId, senderId)) {
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

  await db.transaction(async () => {
    await db.run('DELETE FROM dm_reactions WHERE message_id = ?', [messageId]);
    await db.run('DELETE FROM direct_messages WHERE id = ?', [messageId]);
  });

  const event = { type: 'delete_dm', messageId, sender_id: row.sender_id };
  sendToUserSockets(row.recipient_id, event);
  sendToUserSockets(row.sender_id, event);
  res.json({ success: true, deletedId: messageId });
});

// Only the sender can edit a message (`content` is the new ciphertext).
router.put('/update-message/:id', authenticateJWT, async (req, res) => {
  const messageId = parseInt(req.params.id, 10);
  const { content } = req.body;
  if (!messageId || !content || typeof content !== 'string') {
    return res.status(400).json({ error: 'Invalid input' });
  }
  if (content.length > maxMessageLength) {
    return res.status(400).json({ error: `Message too long. Max length is ${maxPlaintextLength} characters.` });
  }

  const row = await db.get('SELECT * FROM direct_messages WHERE id = ?', [messageId]);
  if (!row) return res.status(404).json({ error: 'Message not found' });
  if (row.sender_id !== req.user.id) return res.status(403).json({ error: 'Not authorized' });

  await db.run('UPDATE direct_messages SET content = ?, edited = 1 WHERE id = ?', [content, messageId]);

  const event = { type: 'edit_dm', messageId, content };
  sendToUserSockets(row.recipient_id, event);
  sendToUserSockets(row.sender_id, event);
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
    'SELECT id, sender_id, recipient_id FROM direct_messages WHERE id = ?',
    [messageId]
  );
  if (!row || (row.sender_id !== req.user.id && row.recipient_id !== req.user.id)) {
    return res.status(404).json({ error: 'Message not found' });
  }
  const result = await setPinned(
    'direct_messages', messageId, req.user.id, pinned,
    '((sender_id = ? AND recipient_id = ?) OR (sender_id = ? AND recipient_id = ?))',
    [row.sender_id, row.recipient_id, row.recipient_id, row.sender_id]
  );
  if (result.error) return res.status(result.status).json({ error: result.error });
  const pin = { messageId, pinned_at: result.pinned_at, pinned_by: result.pinned_by };
  if (result.changed) {
    const event = { type: 'dm_pin', sender_id: row.sender_id, recipient_id: row.recipient_id, ...pin };
    sendToUserSockets(row.recipient_id, event);
    sendToUserSockets(row.sender_id, event);
  }
  res.json(pin);
}

router.put('/dm-messages/:id/pin', authenticateJWT, (req, res) => pinRoute(req, res, true));
router.delete('/dm-messages/:id/pin', authenticateJWT, (req, res) => pinRoute(req, res, false));

module.exports = router;
