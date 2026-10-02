const express = require('express');
const db = require('../db');
const { authenticateJWT } = require('../auth');
const { PERMISSIONS, has } = require('../permissions');
const { getChannelAccess, getChannelViewers } = require('../guilds');
const { getDocument } = require('../guildDocuments');
const groups = require('../groupDms');
const { sendToUserSockets } = require('../sockets');

// "Someone is typing…" (like Discord's POST /channels/:id/typing). The client posts at most
// every few seconds while its message box has text; everyone else who can see the chat gets
// `typing { chatId, userId }`, `chatId` being the chat as *they* name it (client chat ids: the
// other person's id for a DM, `group-<id>`, `channel-<id>`, `document-<id>` for a document's
// replies). Nothing is stored; the client forgets it after a few seconds or when that person's
// message arrives. In DMs and group DMs this tells the server when someone is typing to whom
// (it already sees when they send), never what.
const router = express.Router();

// A client can't make the server fan out more often than this per chat.
const MIN_INTERVAL_MS = 1000;
const lastSent = new Map(); // `${userId}:${chatId}` -> ms

// Who gets the event (everyone but the typer) and the chat id they know the chat by, or null if
// `userId` can't write there.
async function audienceFor(chatId, userId) {
  const [, kind, id] = /^(?:(group|channel|document)-)?([\w-]{1,64})$/.exec(chatId) ?? [];
  if (!id) return null;
  if (kind === 'group') {
    if (!(await groups.memberState(id, userId))) return null;
    return { userIds: await groups.memberIds(id), chatId };
  }
  if (!/^\d+$/.test(id)) return null;
  const numericId = Number(id);
  if (!kind) {
    if (numericId === userId) return null; // notes to yourself
    const other = await db.get('SELECT id FROM users WHERE id = ? AND deleted_at IS NULL', [numericId]);
    return other ? { userIds: [other.id], chatId: String(userId) } : null;
  }
  let channelId = numericId;
  if (kind === 'document') {
    const document = await getDocument(numericId);
    if (!document) return null;
    channelId = document.channel_id;
  }
  const access = await getChannelAccess(channelId, userId);
  if (!access || access.channel.type !== (kind === 'document' ? 'doc' : 'text')) return null;
  if (!has(access.permissions, PERMISSIONS.VIEW_CHANNEL) || !has(access.permissions, PERMISSIONS.SEND_MESSAGES)) return null;
  return { userIds: await getChannelViewers(access.channel), chatId };
}

router.post('/typing', authenticateJWT, async (req, res) => {
  const chatId = String(req.body?.chatId ?? '');
  const key = `${req.user.id}:${chatId}`;
  const now = Date.now();
  // Too soon after the last one (typing again straight after sending, say): the client tries
  // again with a later keystroke.
  if (now - (lastSent.get(key) ?? 0) < MIN_INTERVAL_MS) return res.status(429).json({ error: 'Too soon' });

  const audience = await audienceFor(chatId, req.user.id);
  if (!audience) return res.status(404).json({ error: 'Chat not found' });
  lastSent.set(key, now);
  // Old entries go now and then, so the map stays small.
  if (lastSent.size > 10000) {
    for (const [k, at] of lastSent) if (now - at >= MIN_INTERVAL_MS) lastSent.delete(k);
  }
  const event = { type: 'typing', chatId: audience.chatId, userId: req.user.id };
  for (const userId of audience.userIds) {
    if (userId !== req.user.id) sendToUserSockets(userId, event);
  }
  res.status(204).end();
});

module.exports = router;
