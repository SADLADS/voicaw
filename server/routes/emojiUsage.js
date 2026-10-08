const express = require('express');
const { authenticateJWT } = require('../auth');
const { sendToUserSockets } = require('../sockets');
const { getEmojiUsage, saveEmojiUsage } = require('../emojiUsage');

// Your encrypted emoji usage (emojiUsage.js).
const router = express.Router();

router.get('/emoji-usage', authenticateJWT, async (req, res) => {
  res.json(await getEmojiUsage(req.user.id));
});

// { emojiUsage, version } (the version it was made from) -> the saved one; 409 with the
// current one if that's stale. Your other devices get `emoji_usage`.
router.put('/emoji-usage', authenticateJWT, async (req, res) => {
  const result = await saveEmojiUsage(req.user.id, req.body?.emojiUsage, req.body?.version);
  if (result.error) return res.status(400).json({ error: result.error });
  if (result.conflict) return res.status(409).json(result.conflict);
  sendToUserSockets(req.user.id, { type: 'emoji_usage', ...result.saved });
  res.json(result.saved);
});

module.exports = router;
