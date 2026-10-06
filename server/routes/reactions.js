const express = require('express');
const db = require('../db');
const { CALL_LOG } = require('../callLog');
const { getMaxEncryptedLength } = require('../config');
const { authenticateJWT } = require('../auth');
const { sendToUserSockets } = require('../sockets');

// Reactions. The emoji is encrypted by the client with the conversation key, padded to
// REACTION_PLAINTEXT_BYTES so every reaction is the same length; the server sees only who
// reacted to which message, and when. They're returned with messages (routes/dms.js).
// Poll votes and the answers people add to open polls are reactions too, so the limit per
// person covers a whole poll's worth (20 answers, votes for all of them and a few of their own).
const router = express.Router();

// 256 since answers could be added to polls; apps from before pad to 64.
const REACTION_LENGTHS = [256, 64].map(getMaxEncryptedLength);
const MAX_REACTIONS_PER_USER_PER_MESSAGE = 50;

// The DM `messageId` if `userId` is one of its two participants.
async function getDmForParticipant(messageId, userId) {
  if (!Number.isInteger(messageId)) return null;
  const row = await db.get('SELECT id, sender_id, recipient_id, system FROM direct_messages WHERE id = ?', [messageId]);
  return row && (row.sender_id === userId || row.recipient_id === userId) ? row : null;
}

// Both participants (once, for a note-to-self conversation).
function notifyParticipants(message, event) {
  sendToUserSockets(message.sender_id, event);
  if (message.recipient_id !== message.sender_id) sendToUserSockets(message.recipient_id, event);
}

router.post('/dm-reactions', authenticateJWT, async (req, res) => {
  const userId = req.user.id;
  const messageId = Number(req.body?.messageId);
  const { content } = req.body ?? {};

  if (typeof content !== 'string' || !content.startsWith('v1.') || !REACTION_LENGTHS.includes(content.length)) {
    return res.status(400).json({ error: 'Invalid reaction' });
  }
  const message = await getDmForParticipant(messageId, userId);
  if (!message) return res.status(404).json({ error: 'Message not found' });
  if (message.system === CALL_LOG) return res.status(403).json({ error: "A call in the chat can't be changed" });

  const { count } = await db.get(
    'SELECT COUNT(*) AS count FROM dm_reactions WHERE message_id = ? AND user_id = ?',
    [messageId, userId]
  );
  if (count >= MAX_REACTIONS_PER_USER_PER_MESSAGE) {
    return res.status(400).json({ error: 'Too many reactions on this message' });
  }

  const { lastID } = await db.run(
    `INSERT INTO dm_reactions (message_id, user_id, content, timestamp) VALUES (?, ?, ?, strftime('%s','now'))`,
    [messageId, userId, content]
  );
  const reaction = await db.get(
    'SELECT id, message_id, user_id, content, timestamp FROM dm_reactions WHERE id = ?',
    [lastID]
  );

  notifyParticipants(message, { type: 'reaction_add', reaction });
  res.status(201).json(reaction);
});

// Only your own reactions can be removed.
router.delete('/dm-reactions/:id', authenticateJWT, async (req, res) => {
  const reactionId = Number(req.params.id);
  const reaction = Number.isInteger(reactionId) && await db.get(
    'SELECT id, message_id, user_id FROM dm_reactions WHERE id = ?',
    [reactionId]
  );
  if (!reaction) return res.status(404).json({ error: 'Reaction not found' });
  if (reaction.user_id !== req.user.id) return res.status(403).json({ error: 'Not your reaction' });

  const message = await db.get('SELECT sender_id, recipient_id FROM direct_messages WHERE id = ?', [reaction.message_id]);
  await db.run('DELETE FROM dm_reactions WHERE id = ?', [reactionId]);

  if (message) notifyParticipants(message, { type: 'reaction_remove', reactionId, messageId: reaction.message_id });
  res.json({ success: true });
});

module.exports = router;
