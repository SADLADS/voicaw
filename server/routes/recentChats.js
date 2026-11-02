const express = require('express');
const { authenticateJWT } = require('../auth');
const { recentChatsFor } = require('../recentChats');

// Where you last sent a message, newest first (recentChats.js): the share screen's order,
// [{ kind: 'dm' | 'group' | 'channel', id, at }].
const router = express.Router();

router.get('/recent-chats', authenticateJWT, async (req, res) => {
  res.json(await recentChatsFor(req.user.id));
});

module.exports = router;
