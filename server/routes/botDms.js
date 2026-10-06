const express = require('express');
const db = require('../db');
const config = require('../config');
const { authenticateJWT } = require('../auth');
const { createLimiter } = require('../rateLimit');
const botDms = require('../botDms');

// Bot DMs for the app (botDms.js; bots use the bot API's DM channel routes). Not end-to-end
// encrypted: the server stores and reads these messages, and the app says so.
const router = express.Router();

// Loads req.dm: one of the caller's own conversations with a bot.
async function ownDm(req, res, next) {
  const dm = await botDms.getDm(Number(req.params.dmId));
  if (!dm || dm.user_id !== req.user.id) return res.status(404).json({ error: 'Conversation not found' });
  req.dm = dm;
  next();
}

const fail = (res, err) => {
  if (err instanceof botDms.BotDmError) return res.status(err.status).json({ error: err.message });
  throw err;
};

// 10 messages per 10 s per person, across their bot DMs.
const sendLimiter = createLimiter({ windowMs: 10 * 1000, max: 10 });

// [{ id, bot_id, last_timestamp, unread, last_unread_sender_id, last_unread_timestamp }].
router.get('/bot-dms', authenticateJWT, async (req, res) => {
  res.json(await botDms.listForUser(req.user.id));
});

// Starts (or finds) a conversation with bot `bot_id`, from its profile: the same rules as a
// bot opening one (a shared guild, no block, bot DMs allowed). Answers its summary.
router.post('/bot-dms', authenticateJWT, async (req, res) => {
  const botId = Number(req.body?.bot_id);
  const bot = Number.isSafeInteger(botId) && await db.get('SELECT id FROM users WHERE id = ? AND bot = 1', [botId]);
  if (!bot) return res.status(404).json({ error: 'Bot not found' });
  try {
    await botDms.checkAllowed(botId, req.user.id);
  } catch (err) {
    return fail(res, err);
  }
  const dm = await botDms.openDm(botId, req.user.id);
  const [entry] = (await botDms.listForUser(req.user.id)).filter((d) => d.id === dm.id);
  res.status(201).json(entry);
});

// Messages, oldest first: the newest `limit` (50), or those `before` a message id.
router.get('/bot-dms/:dmId/messages', authenticateJWT, ownDm, async (req, res) => {
  const before = req.query.before != null ? Number(req.query.before) : null;
  const rows = await botDms.listMessages(req.dm.id, { before, limit: req.query.limit });
  res.json(rows.map(botDms.appMessage));
});

// The person's plain-text message: { content }.
router.post('/bot-dms/:dmId/messages', authenticateJWT, ownDm, async (req, res) => {
  if (config.rateLimitsEnabled && !sendLimiter.hit(String(req.user.id)).allowed) {
    return res.status(429).json({ error: 'You are sending messages too quickly' });
  }
  const content = botDms.cleanPersonText(req.body?.content);
  if (!content) return res.status(400).json({ error: `Messages are 1–${botDms.MAX_PERSON_MESSAGE} characters` });
  try {
    const row = await botDms.createMessage(req.dm, req.user.id, { content });
    res.status(201).json(botDms.appMessage(row));
  } catch (err) {
    fail(res, err);
  }
});

// Loads req.message: one of the caller's own messages in req.dm.
async function ownMessage(req, res, next) {
  const message = await botDms.getMessage(req.dm.id, Number(req.params.messageId));
  if (!message) return res.status(404).json({ error: 'Message not found' });
  if (message.sender_id !== req.user.id) return res.status(403).json({ error: 'You can only change your own messages' });
  req.message = message;
  next();
}

router.put('/bot-dms/:dmId/messages/:messageId', authenticateJWT, ownDm, ownMessage, async (req, res) => {
  const content = botDms.cleanPersonText(req.body?.content);
  if (!content) return res.status(400).json({ error: `Messages are 1–${botDms.MAX_PERSON_MESSAGE} characters` });
  res.json(botDms.appMessage(await botDms.editMessage(req.dm, req.message.id, { content })));
});

router.delete('/bot-dms/:dmId/messages/:messageId', authenticateJWT, ownDm, ownMessage, async (req, res) => {
  await botDms.deleteMessage(req.dm, req.message.id);
  res.json({ success: true });
});

// Read up to `messageId` (or, without one, up to the newest).
router.post('/bot-dms/:dmId/read', authenticateJWT, ownDm, async (req, res) => {
  await botDms.markRead(req.dm, req.body?.messageId);
  res.json({ success: true });
});

// Deletes the whole conversation, for the bot too.
router.delete('/bot-dms/:dmId', authenticateJWT, ownDm, async (req, res) => {
  await botDms.deleteConversation(req.dm);
  res.json({ success: true });
});

module.exports = router;
