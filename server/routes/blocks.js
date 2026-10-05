const express = require('express');
const db = require('../db');
const { authenticateJWT } = require('../auth');
const blocks = require('../blocks');
const { sendToUserSockets } = require('../sockets');

// Your blocked list (blocks.js): GET it, PUT or DELETE /blocks/:userId. Your other devices get
// `blocks` with the new list.
const router = express.Router();

async function announce(userId) {
  sendToUserSockets(userId, { type: 'blocks', blocked: await blocks.blockedBy(userId) });
}

router.get('/blocks', authenticateJWT, async (req, res) => {
  res.json({ blocked: await blocks.blockedBy(req.user.id) });
});

router.put('/blocks/:userId', authenticateJWT, async (req, res) => {
  const id = Number(req.params.userId);
  if (!Number.isInteger(id) || id === req.user.id) return res.status(400).json({ error: 'Invalid user' });
  // Bots aren't blocked (they're in guilds only: remove them there); deleted accounts needn't be.
  const user = await db.get('SELECT id FROM users WHERE id = ? AND bot = 0', [id]);
  if (!user) return res.status(404).json({ error: 'User not found' });
  await blocks.block(req.user.id, id);
  await announce(req.user.id);
  res.json({ blocked: await blocks.blockedBy(req.user.id) });
});

router.delete('/blocks/:userId', authenticateJWT, async (req, res) => {
  const id = Number(req.params.userId);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid user' });
  await blocks.unblock(req.user.id, id);
  await announce(req.user.id);
  res.json({ blocked: await blocks.blockedBy(req.user.id) });
});

module.exports = router;
