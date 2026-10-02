const express = require('express');
const { authenticateJWT } = require('../auth');
const { sendToUserSockets } = require('../sockets');
const { getDictionary, saveDictionary } = require('../dictionary');

// Your encrypted spellcheck dictionary (dictionary.js).
const router = express.Router();

router.get('/dictionary', authenticateJWT, async (req, res) => {
  res.json(await getDictionary(req.user.id));
});

// { dictionary, version } (the version it was made from) -> the saved one; 409 with the
// current one if that's stale. Your other devices get `dictionary`.
router.put('/dictionary', authenticateJWT, async (req, res) => {
  const result = await saveDictionary(req.user.id, req.body?.dictionary, req.body?.version);
  if (result.error) return res.status(400).json({ error: result.error });
  if (result.conflict) return res.status(409).json(result.conflict);
  sendToUserSockets(req.user.id, { type: 'dictionary', ...result.saved });
  res.json(result.saved);
});

module.exports = router;
