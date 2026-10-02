const express = require('express');
const { authenticateJWT } = require('../auth');
const { sendToUserSockets } = require('../sockets');
const { getPreferences, changePreferences } = require('../preferences');

// Your own settings that follow your account (preferences.js).
const router = express.Router();

router.get('/preferences', authenticateJWT, async (req, res) => {
  res.json(await getPreferences(req.user.id));
});

// Changes the preferences in the body (others are kept); -> all of them. Your other devices
// get `preferences`.
router.put('/preferences', authenticateJWT, async (req, res) => {
  const preferences = await changePreferences(req.user.id, req.body);
  if (typeof preferences === 'string') return res.status(400).json({ error: preferences });
  sendToUserSockets(req.user.id, { type: 'preferences', preferences });
  res.json(preferences);
});

module.exports = router;
