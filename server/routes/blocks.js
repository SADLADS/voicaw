const express = require('express');
const db = require('../db');
const { authenticateJWT } = require('../auth');
const blocks = require('../blocks');
const friends = require('../friends');
const { sendToUserSockets } = require('../sockets');
const { clearFriendRequest } = require('../friendPushes');

// Your blocked list (blocks.js): GET it, PUT or DELETE /blocks/:userId, and webhooks with PUT
// or DELETE /blocks/webhooks/:webhookId. Each answers, and your other devices get `blocks` with,
// the new lists: { blocked: [user ids], webhooks: [{ id, name, guild_id, guild_name }] }.
const router = express.Router();

async function announce(userId) {
  const list = await blocks.blockList(userId);
  sendToUserSockets(userId, { type: 'blocks', ...list });
  return list;
}

router.get('/blocks', authenticateJWT, async (req, res) => {
  res.json(await blocks.blockList(req.user.id));
});

// Before /blocks/:userId, which would take "webhooks" as an id.
router.put('/blocks/webhooks/:webhookId', authenticateJWT, async (req, res) => {
  const id = Number(req.params.webhookId);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'Invalid webhook' });
  if (!(await blocks.blockWebhook(req.user.id, id))) return res.status(404).json({ error: 'Webhook not found' });
  res.json(await announce(req.user.id));
});

router.delete('/blocks/webhooks/:webhookId', authenticateJWT, async (req, res) => {
  const id = Number(req.params.webhookId);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid webhook' });
  await blocks.unblockWebhook(req.user.id, id);
  res.json(await announce(req.user.id));
});

router.put('/blocks/:userId', authenticateJWT, async (req, res) => {
  const id = Number(req.params.userId);
  if (!Number.isInteger(id) || id === req.user.id) return res.status(400).json({ error: 'Invalid user' });
  // Bots can be blocked too: then they can't DM you (botDms.js). Deleted accounts needn't be.
  const user = await db.get('SELECT id FROM users WHERE id = ?', [id]);
  if (!user) return res.status(404).json({ error: 'User not found' });
  await blocks.block(req.user.id, id);
  // Blocking ends a friendship and any request either way (friends.js).
  if (await friends.remove(req.user.id, id)) {
    for (const userId of [req.user.id, id]) {
      sendToUserSockets(userId, { type: 'friends', ...(await friends.listFor(userId)) });
    }
    clearFriendRequest(req.user.id, id);
    clearFriendRequest(id, req.user.id);
  }
  res.json(await announce(req.user.id));
});

router.delete('/blocks/:userId', authenticateJWT, async (req, res) => {
  const id = Number(req.params.userId);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid user' });
  await blocks.unblock(req.user.id, id);
  res.json(await announce(req.user.id));
});

module.exports = router;
